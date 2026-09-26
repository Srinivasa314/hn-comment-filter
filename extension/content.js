// Runs on HN item pages: reads the comment tree, asks the background worker to score every comment,
// and filters the ones below the score threshold (see HNCF.layout). Unscored comments stay visible.

(async () => {
  const tree = document.querySelector("table.comment-tree");
  if (!tree) return;

  const story = parseStory();
  // `comments` is always in current page order (it changes when sorted), which apply() relies on.
  let comments = parseComments([...tree.querySelectorAll("tr.athing.comtr")]);
  if (!comments.length) return;
  const scorable = comments.filter((c) => c.text);
  const originalOrder = [...comments];
  const roots = HNCF.linkTree(comments);
  const rowParent = comments[0].row.parentElement;
  const afterRows = comments.at(-1).row.nextSibling; // e.g. HN's "more" link row stays last

  let settings = await HNCF.getSettings();
  const scores = new Map(); // comment id -> 0..1
  const errors = new Map(); // comment id -> message
  const expandedContext = new Set(); // context comments the reader chose to read in full
  const openGroups = new Set(); // folded groups the reader opened, keyed by their first comment's id
  let foldLines = []; // the "N filtered comments" rows currently in the table
  let status = { state: "idle" };
  let port = null;
  let reconnects = 0;
  let applyQueued = false;

  const bar = buildBar();
  tree.before(bar.el);
  for (const c of comments) c.row.querySelector(".comhead")?.append(c.badge);
  start();

  // HN's own [–] collapse hides replies; re-layout so fold lines under a collapsed comment hide too.
  const flipped = (r, cls) => ` ${r.oldValue ?? ""} `.includes(` ${cls} `) !== r.target.classList.contains(cls);
  new MutationObserver((records) => {
    if (records.some((r) => flipped(r, "coll") || flipped(r, "noshow"))) scheduleApply();
  }).observe(tree, { subtree: true, attributes: true, attributeFilter: ["class"], attributeOldValue: true });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    const oldKey = HNCF.criteriaKey(settings.criteria);
    for (const [k, { newValue }] of Object.entries(changes)) {
      settings[k] = newValue ?? HNCF.DEFAULT_SETTINGS[k];
    }
    bar.sync();
    if (HNCF.criteriaKey(settings.criteria) !== oldKey || (settings.enabled && !port)) start();
    else {
      if ("sort" in changes || "enabled" in changes) reorder();
      scheduleApply();
    }
  });

  // ---- page parsing ------------------------------------------------------------------------------

  function parseStory() {
    const id = new URL(location.href).searchParams.get("id");
    const link = document.querySelector(".fatitem .titleline > a");
    const text = document.querySelector(".fatitem .toptext")?.innerText.trim() || undefined;
    if (link) {
      const external = new URL(link.href).origin !== location.origin;
      return { id, title: link.textContent, url: external ? link.href : undefined, text };
    }
    // Comment permalink pages show "on: <story title>" instead of a title line.
    const on = document.querySelector(".fatitem .onstory a");
    return { id, title: on?.textContent ?? document.title, text };
  }

  function parseComments(rows) {
    // On a comment permalink page the top-level replies answer the comment shown above the tree.
    const rootText = document.querySelector(".fatitem .commtext")?.innerText.trim() || null;
    const lastTextAtDepth = [];
    return rows.map((row) => {
      const depth = Number(row.querySelector("td.ind")?.getAttribute("indent") ?? 0);
      const text = row.querySelector(".commtext")?.innerText.trim() ?? "";
      const parentText = depth === 0 ? rootText : lastTextAtDepth[depth - 1] || null;
      lastTextAtDepth[depth] = text;
      lastTextAtDepth.length = depth + 1;
      const badge = document.createElement("span");
      badge.className = "hncf-badge";
      // Shown only while the comment is displayed as shortened context for a reply below it.
      const more = document.createElement("a");
      more.href = "#";
      more.className = "hncf-more";
      more.addEventListener("click", (e) => {
        e.preventDefault();
        if (expandedContext.has(row.id)) expandedContext.delete(row.id);
        else expandedContext.add(row.id);
        scheduleApply();
      });
      row.querySelector(".commtext")?.after(more);
      return { id: row.id, row, depth, text, parentText, badge, more };
    });
  }

  // ---- scoring -----------------------------------------------------------------------------------

  function start() {
    if (port) {
      port.onDisconnect.removeListener(onDisconnect);
      port.disconnect();
      port = null;
    }
    scores.clear();
    errors.clear();
    if (!settings.enabled) {
      status = { state: "off" };
      return scheduleApply();
    }
    status = { state: "scoring" };
    port = chrome.runtime.connect({ name: "score" });
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    port.postMessage({
      type: "score",
      story,
      comments: scorable.map(({ id, text, parentText }) => ({ id, text, parentText })),
    });
    scheduleApply();
  }

  function onMessage(msg) {
    if (msg.type === "result") {
      scores.set(msg.id, msg.score);
      errors.delete(msg.id);
      if (status.pausedUntil) status = { state: "scoring" };
    } else if (msg.type === "error") {
      errors.set(msg.id, msg.message);
    } else if (msg.type === "paused") {
      status = { state: "scoring", pausedUntil: msg.until };
      tickWhilePaused();
    } else if (msg.type === "done") {
      status = { state: "done" };
      reconnects = 0;
      reorder();
    } else if (msg.type === "fatal") {
      status = { state: "fatal", message: msg.message };
    }
    scheduleApply();
  }

  // Count down the rate-limit pause in the status line.
  let pauseTimer = null;
  function tickWhilePaused() {
    if (pauseTimer) return;
    pauseTimer = setInterval(() => {
      if (!status.pausedUntil) {
        clearInterval(pauseTimer);
        pauseTimer = null;
      }
      scheduleApply();
    }, 1000);
  }

  // The service worker can be stopped mid-run; reconnecting is cheap because finished comments are cached.
  function onDisconnect() {
    port = null;
    if (status.state === "scoring" && reconnects < 3) {
      reconnects++;
      setTimeout(start, 1000);
    }
  }

  // ---- ordering ----------------------------------------------------------------------------------

  // Moves whole subtrees, so every reply still follows its parent (HN's own [–] collapse relies on
  // that). Runs once scoring is done, not per result, so the page doesn't shuffle while it fills in.
  // Top-level comments rank by the best comment in their branch, so a weak question with an excellent
  // answer rises; replies rank by their own score.
  function reorder() {
    const byScore = settings.enabled && settings.sort === "score";
    const key = (c) => (c.depth === 0 ? HNCF.bestInBranch(c, scoreOf) : scoreOf(c));
    const order = byScore ? HNCF.sortedPreorder(roots, key) : originalOrder;
    if (order.every((c, i) => c === comments[i])) return;

    // Keep the comment at the top of the viewport where it is, so a reader doesn't lose their place.
    const anchor = comments.find((c) => c.row.offsetParent && c.row.getBoundingClientRect().bottom > 0);
    const before = anchor?.row.getBoundingClientRect().top;
    const frag = document.createDocumentFragment();
    for (const c of order) frag.append(c.row);
    rowParent.insertBefore(frag, afterRows);
    comments = order;
    apply(); // fold lines belong to the old order
    if (anchor && window.scrollY > 0) window.scrollBy(0, anchor.row.getBoundingClientRect().top - before);
  }

  // ---- filtering ---------------------------------------------------------------------------------

  // Batches bursts of results into one pass. A timer rather than requestAnimationFrame, which never
  // fires in background tabs (threads opened with cmd-click would stay unfiltered until viewed).
  function scheduleApply() {
    if (applyQueued) return;
    applyQueued = true;
    setTimeout(() => {
      applyQueued = false;
      apply();
    }, 50);
  }

  const scoreOf = (c) => scores.get(c.id) ?? null;

  function apply() {
    const on = settings.enabled;
    const pageScores = comments.map(scoreOf);
    const kept = comments.map((c, i) => !on || pageScores[i] == null || pageScores[i] >= settings.threshold);
    const { states, groups } = HNCF.layout(comments.map((c) => c.depth), kept);

    for (const line of foldLines) line.remove();
    foldLines = [];
    const folded = new Array(comments.length).fill(false);
    for (const g of groups) {
      const key = comments[g.start].id;
      const open = openGroups.has(key);
      if (!open) for (let i = g.start; i < g.end; i++) folded[i] = true;
      // The group's parent is the nearest earlier comment one level up; if HN has it collapsed (or
      // hidden under a collapsed ancestor), the line would dangle, so leave it out.
      const parent = comments.slice(0, g.start).findLast((c) => c.depth === g.depth - 1);
      if (parent && (parent.row.classList.contains("coll") || parent.row.classList.contains("noshow"))) continue;
      foldLines.push(foldLine(g, key, open));
    }

    comments.forEach((c, i) => {
      const context = states[i] === "context";
      const shortened = context && !expandedContext.has(c.id);
      c.row.classList.toggle("hncf-context", context);
      c.row.classList.toggle("hncf-shortened", shortened);
      c.row.classList.toggle("hncf-folded", folded[i]);
      c.row.classList.toggle("hncf-unfolded", states[i] === "folded" && !folded[i]);
      c.more.textContent = shortened ? "show more" : "show less";
      renderBadge(c, pageScores[i], states[i]);
    });
    bar.status(states.filter((s) => s !== "kept").length);
  }

  function foldLine(group, key, open) {
    const row = document.createElement("tr");
    row.className = "hncf-fold";
    const cell = row.insertCell();
    cell.style.paddingLeft = `${group.depth * 40 + 14}px`; // HN indents 40px per level, plus the vote arrow
    const button = document.createElement("button");
    button.type = "button";
    button.className = "hncf-fold-button";
    const n = `${group.count} filtered comment${group.count === 1 ? "" : "s"}`;
    button.textContent = open ? `▾ hide ${n}` : `▸ ${n}`;
    button.addEventListener("click", () => {
      if (openGroups.has(key)) openGroups.delete(key);
      else openGroups.add(key);
      apply();
    });
    // Inside HN's comment-header class, so it matches the headers however they're styled.
    const head = document.createElement("span");
    head.className = "comhead";
    head.append(button);
    cell.append(head);
    comments[group.start].row.before(row);
    return row;
  }

  function renderBadge(c, score, state) {
    const b = c.badge;
    b.hidden = !settings.enabled || !c.text;
    b.classList.toggle("hncf-filtered", state !== "kept");
    b.classList.toggle("hncf-error", errors.has(c.id));
    if (errors.has(c.id)) {
      b.textContent = "!";
      b.title = `Couldn't score this comment: ${errors.get(c.id)}`;
      return;
    }
    if (score == null) {
      b.textContent = status.state === "scoring" ? "…" : "–";
      b.title = status.state === "scoring" ? "Scoring…" : "Not scored";
      return;
    }
    const pct = Math.round(score * 100);
    const why = {
      kept: "",
      context: " · below the threshold, shown as context for a reply",
      folded: " · below the threshold",
    }[state];
    b.textContent = `${pct}`;
    b.title =
      `Score ${pct} (threshold ${Math.round(settings.threshold * 100)})${why}\n` +
      `Closest level: ${HNCF.nearestLevel(score, settings.criteria.levels)}`;
  }

  // ---- toolbar -----------------------------------------------------------------------------------

  function buildBar() {
    const el = document.createElement("div");
    el.className = "hncf-bar";
    el.innerHTML = `
      <label><input type="checkbox" class="hncf-enabled"> filter comments</label>
      <span class="hncf-status"></span>
      <a href="#" class="hncf-settings">settings</a>`;
    const $ = (s) => el.querySelector(s);
    const enabled = $(".hncf-enabled");
    const statusEl = $(".hncf-status");

    enabled.addEventListener("change", () => chrome.storage.sync.set({ enabled: enabled.checked }));
    $(".hncf-settings").addEventListener("click", (e) => {
      e.preventDefault();
      chrome.runtime.sendMessage({ type: "open-options" });
    });

    const sync = () => {
      enabled.checked = settings.enabled;
    };
    sync();

    const setStatus = (filtered) => {
      const scored = scores.size;
      const failed = errors.size ? ` · ${errors.size} failed` : "";
      statusEl.classList.toggle("hncf-status-error", status.state === "fatal");
      if (status.state === "off") statusEl.textContent = "";
      else if (status.state === "fatal") {
        statusEl.textContent =
          status.message === "missing-credentials"
            ? "Add your TypeSafe API key in settings to start filtering."
            : `Scoring stopped: ${status.message}`;
      } else if (status.state === "scoring") {
        const wait = status.pausedUntil ? Math.ceil((status.pausedUntil - Date.now()) / 1000) : 0;
        const paused = wait > 0 ? ` · rate limited by TypeSafe, resuming in ${wait}s` : "";
        statusEl.textContent = `scoring ${scored}/${scorable.length}… · ${filtered} filtered${failed}${paused}`;
      } else {
        statusEl.textContent = `${filtered} of ${comments.length} filtered${failed}`;
      }
    };
    return { el, sync, status: setStatus };
  }
})();
