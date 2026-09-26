// Shared between the content script, background worker and options page (loaded as a classic script).
// Everything hangs off one global so the three contexts agree on defaults and scoring maths.

var HNCF = (() => {
  // Each comment is rated by one Jev score question; its expected level, rescaled to 0..1, is the
  // comment's score.
  const DEFAULT_CRITERIA = {
    question:
      "How worth reading is `comment` for someone skimming the Hacker News discussion of `story_title`? " +
      "Judge what it adds, not its length or tone.",
    levels: [
      "nothing: a joke, snark, sarcasm, an empty reaction, or off-topic",
      "little: generic opinion, simple agreement or disagreement, or a point already made in `parent_excerpt`",
      "something: a reasoned argument, a useful fact or correction, a good question, or relevant experience",
      "a lot: expert or first-hand insight, concrete evidence or data, or an idea that changes how you see `story_title`",
    ],
  };

  const DEFAULT_SETTINGS = {
    enabled: true,
    threshold: 0.6, // on the 0..1 score scale
    sort: "score", // score (best first) | original
    criteria: DEFAULT_CRITERIA,
  };

  const PRICE_PER_MTOK = 0.042; // TypeSafe list price for Jev input tokens; output is free

  async function getSettings() {
    const stored = await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS));
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  // Cache key for the criteria: cached scores are only valid for the wording they were scored with.
  function criteriaKey(criteria) {
    const s = JSON.stringify([criteria.question, criteria.levels]);
    let h = 0x811c9dc5; // FNV-1a
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  // Several comments go into one Jev call: the state holds them as comments.c0, comments.c1, … and the
  // question is repeated per comment with its `comment` / `parent_excerpt` references pointed at that
  // slot. This keeps request counts well under the rate limit and uses fewer tokens than one call per
  // comment.
  const BATCH_SIZE = 10;
  const COMMENT_FIELDS = ["comment", "parent_excerpt"];

  function buildBatchState(story, comments) {
    const state = { story_title: story.title };
    if (story.url) state.story_url = story.url;
    if (story.text) state.story_text = story.text.slice(0, 1000);
    state.comments = {};
    comments.forEach((c, i) => {
      const entry = {};
      if (c.parentText) entry.parent_excerpt = c.parentText.slice(0, 500);
      entry.comment = c.text.slice(0, 6000);
      state.comments[`c${i}`] = entry;
    });
    return state;
  }

  // One score question per comment slot, keyed c0, c1, …; references in the levels are rewritten too.
  function batchQuestions(criteria, count) {
    const out = {};
    for (let i = 0; i < count; i++) {
      const scoped = (text) =>
        COMMENT_FIELDS.reduce((t, f) => t.replaceAll(`\`${f}\``, `\`comments.c${i}.${f}\``), text);
      out[`c${i}`] = { type: "score", instructions: scoped(criteria.question), criteria: criteria.levels.map(scoped) };
    }
    return out;
  }

  // Jev's expected level (0 .. levels-1) rescaled to 0..1; null if the answer is missing.
  function scoreFromAnswer(answer, levels) {
    return answer?.type === "score" ? answer.score / (levels.length - 1) : null;
  }

  // The level description a 0..1 score is closest to, for explaining a badge.
  function nearestLevel(score, levels) {
    return levels[Math.round(score * (levels.length - 1))];
  }

  // For comments in page order with their depths, whether each has a kept comment somewhere in its
  // subtree. Walks backwards; keptAtDepth[d] records whether anything was kept among the depth-d
  // comments (and their subtrees) seen since the last shallower comment.
  function keptDescendants(depths, kept) {
    const out = new Array(depths.length).fill(false);
    const keptAtDepth = [];
    for (let i = depths.length - 1; i >= 0; i--) {
      const d = depths[i];
      out[i] = keptAtDepth.slice(d + 1).some(Boolean);
      keptAtDepth.length = d + 1;
      keptAtDepth[d] = Boolean(keptAtDepth[d] || kept[i] || out[i]);
    }
    return out;
  }

  // How each comment (in page order, with depths) is shown:
  //   kept    - scored at or above the threshold (or not scored yet): shown normally
  //   context - filtered, but a kept reply sits somewhere beneath it: shown shortened, so the reply
  //             isn't read without what it answers
  //   folded  - filtered with nothing kept beneath it: hidden behind a "N filtered comments" line
  // Folded comments come in groups: a run of folded sibling branches, shown as one line each.
  function layout(depths, kept) {
    const below = keptDescendants(depths, kept);
    const states = depths.map((d, i) => (kept[i] ? "kept" : below[i] ? "context" : "folded"));
    const groups = [];
    let group = null;
    depths.forEach((d, i) => {
      if (states[i] !== "folded") group = null;
      // A folded comment deeper than the group's top is inside one of its branches; one at the same
      // depth is the next sibling branch (anything between them would have ended the run).
      else if (group && d >= group.depth) {
        group.end = i + 1;
        group.count++;
      } else groups.push((group = { start: i, end: i + 1, depth: d, count: 1 }));
    });
    return { states, groups };
  }

  // Best score anywhere in an item's branch (itself and all replies), or null if nothing is scored.
  function bestInBranch(item, scoreOf) {
    let best = scoreOf(item) ?? null;
    for (const child of item.children) {
      const b = bestInBranch(child, scoreOf);
      if (b != null && (best == null || b > best)) best = b;
    }
    return best;
  }

  // Gives each item (in page order, with depth) a children array; returns the top-level items.
  function linkTree(items) {
    const roots = [];
    const lastAtDepth = [];
    for (const item of items) {
      item.children = [];
      const parent = item.depth > 0 ? lastAtDepth[item.depth - 1] : null;
      (parent ? parent.children : roots).push(item);
      lastAtDepth[item.depth] = item;
      lastAtDepth.length = item.depth + 1;
    }
    return roots;
  }

  // Page order with every group of siblings sorted by key, highest first, each item followed by its
  // own (sorted) replies. Items without a key (unscored, deleted) rank by their best reply, else last.
  // Ties keep page order.
  function sortedPreorder(roots, keyOf) {
    const keys = new Map();
    const key = (n) => {
      if (!keys.has(n)) keys.set(n, keyOf(n) ?? Math.max(-1, ...n.children.map(key)));
      return keys.get(n);
    };
    const out = [];
    const visit = (nodes) => {
      for (const n of [...nodes].sort((a, b) => key(b) - key(a))) {
        out.push(n);
        visit(n.children);
      }
    };
    visit(roots);
    return out;
  }

  function validateCriteria(criteria) {
    const errors = [];
    const question = criteria.question?.trim() ?? "";
    if (!question) errors.push("The question is empty.");
    else if (!question.includes("`comment`")) {
      errors.push("Refer to the comment as `comment` (with backticks) so Jev knows which comment to judge.");
    }
    const n = criteria.levels?.length ?? 0;
    if (n < 2 || n > 10) errors.push("Give 2–10 levels, lowest first.");
    return errors;
  }

  return {
    DEFAULT_CRITERIA,
    DEFAULT_SETTINGS,
    PRICE_PER_MTOK,
    getSettings,
    criteriaKey,
    BATCH_SIZE,
    buildBatchState,
    batchQuestions,
    scoreFromAnswer,
    nearestLevel,
    keptDescendants,
    layout,
    bestInBranch,
    linkTree,
    sortedPreorder,
    validateCriteria,
  };
})();

if (typeof module !== "undefined") module.exports = HNCF;
