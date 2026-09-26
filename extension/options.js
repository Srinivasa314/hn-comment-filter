const $ = (s) => document.querySelector(s);

function setStatus(el, text, kind = "") {
  el.textContent = text;
  el.className = `status ${kind}`;
}

// ---- credentials ---------------------------------------------------------------------------------

async function loadCredentials() {
  const { typesafe } = await chrome.storage.local.get("typesafe");
  $("#api-key").value = typesafe?.apiKey ?? "";
}

// Saves when the field is committed (Enter or leaving it), then checks the key with one request.
$("#api-key").addEventListener("change", async () => {
  const apiKey = $("#api-key").value.trim();
  const status = $("#credentials-status");
  if (!apiKey) {
    await chrome.storage.local.remove("typesafe");
    return setStatus(status, "");
  }
  await chrome.storage.local.set({ typesafe: { apiKey } });
  setStatus(status, "Saved. Checking the key…");
  const r = await chrome.runtime.sendMessage({ type: "test-credentials", apiKey });
  if (r?.ok) setStatus(status, `Connected (${r.model}).`, "ok");
  else setStatus(status, `Saved, but the check failed: ${r?.message ?? "no response"}`, "error");
});

// ---- criteria ------------------------------------------------------------------------------------

function renderCriteria(criteria) {
  $("#question").value = criteria.question;
  $("#levels").value = criteria.levels.join("\n");
}

function readCriteria() {
  return {
    question: $("#question").value.trim(),
    levels: $("#levels").value.split("\n").map((s) => s.trim()).filter(Boolean),
  };
}

$("#reset-criteria").addEventListener("click", () => {
  renderCriteria(HNCF.DEFAULT_CRITERIA);
  setStatus($("#criteria-status"), "Defaults restored. Save to apply.");
});
$("#save-criteria").addEventListener("click", async () => {
  const criteria = readCriteria();
  const errors = HNCF.validateCriteria(criteria);
  $("#criteria-errors").replaceChildren(
    ...errors.map((e) => Object.assign(document.createElement("li"), { textContent: e })),
  );
  if (errors.length) return setStatus($("#criteria-status"), "");
  await chrome.storage.sync.set({ criteria });
  setStatus($("#criteria-status"), "Saved. Open HN tabs update automatically.", "ok");
});

// ---- threshold ---------------------------------------------------------------------------------

// Shown live while dragging; saved (sync storage is rate limited) when the drag ends. Open HN tabs
// re-filter on save.
function renderThreshold(value) {
  $("#threshold").value = Math.round(value * 100);
  $("#threshold-value").textContent = Math.round(value * 100);
}
$("#threshold").addEventListener("input", () => ($("#threshold-value").textContent = $("#threshold").value));
$("#threshold").addEventListener("change", () => chrome.storage.sync.set({ threshold: Number($("#threshold").value) / 100 }));

// ---- order -------------------------------------------------------------------------------------

function renderSort(value) {
  for (const r of document.querySelectorAll('input[name="sort"]')) r.checked = r.value === value;
}
for (const r of document.querySelectorAll('input[name="sort"]')) {
  r.addEventListener("change", () => r.checked && chrome.storage.sync.set({ sort: r.value }));
}

// ---- usage ---------------------------------------------------------------------------------------

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

async function renderUsage() {
  const { usage = { tokens: 0, comments: 0 } } = await chrome.storage.local.get("usage");
  const cost = (usage.tokens / 1e6) * HNCF.PRICE_PER_MTOK;
  $("#stat-comments").textContent = usage.comments.toLocaleString();
  $("#stat-tokens").textContent = compact.format(usage.tokens);
  $("#stat-cost").textContent = cost === 0 ? "$0" : cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
  $("#usage-since").textContent = usage.since
    ? `since ${new Date(usage.since).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`
    : "";
}

$("#reset-usage").addEventListener("click", async () => {
  await chrome.storage.local.remove("usage");
  renderUsage();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.usage) renderUsage();
});

(async () => {
  await loadCredentials();
  const settings = await HNCF.getSettings();
  renderCriteria(settings.criteria);
  renderThreshold(settings.threshold);
  renderSort(settings.sort);
  renderUsage();
})();
