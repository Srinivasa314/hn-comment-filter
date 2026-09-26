// Background service worker: scores comments with TypeSafe Jev (https://api.typesafe.ai).
//
// A content script opens a "score" port and sends one {story, comments} request. Cached results are
// sent back first, then the rest are scored in batches of comments per Jev call (see buildBatchState),
// several calls at a time, each result posted as it lands.
// Closing the port (navigating away) cancels outstanding work.

importScripts("shared.js");

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const CONCURRENCY = 8;
const RETRIES = 4;
const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;
const DEFAULT_RETRY_AFTER_S = 30;

class FatalError extends Error {}

// TypeSafe allows 1,200 requests a minute (and adjusts limits under load); over that it answers 429,
// usually with Retry-After. The limit is per account, so the pause is shared by every tab.
class RateLimited extends Error {
  constructor(seconds) {
    super(`rate limited for ${seconds}s`);
    this.seconds = seconds;
  }
}
let pausedUntil = 0;

async function getApiKey() {
  const { typesafe } = await chrome.storage.local.get("typesafe");
  if (!typesafe?.apiKey) throw new FatalError("missing-credentials");
  return typesafe.apiKey;
}

// One Jev call. Returns {model, answers, usage}.
async function systemOne(apiKey, state, questions, signal) {
  const body = JSON.stringify({ model: MODEL, state, questions });
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body,
        signal,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      if (attempt < RETRIES) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw e;
    }
    const text = await res.text();
    if (res.ok) {
      const payload = JSON.parse(text);
      if (!payload.answers) throw new Error(`Unexpected TypeSafe response: ${text.slice(0, 300)}`);
      return payload;
    }
    if (res.status === 429) {
      const seconds = Number(res.headers.get("retry-after"));
      throw new RateLimited(seconds > 0 ? seconds : DEFAULT_RETRY_AFTER_S);
    }
    if (res.status >= 500 && attempt < RETRIES) {
      await sleep(500 * 2 ** attempt);
      continue;
    }
    const message = errorMessage(text) || `HTTP ${res.status}`;
    // A bad key or an exhausted account will fail every request, so stop the whole run.
    if ([401, 402, 403].includes(res.status)) throw new FatalError(`TypeSafe ${res.status}: ${message}`);
    throw new Error(`TypeSafe ${res.status}: ${message}`);
  }
}

function errorMessage(text) {
  try {
    const j = JSON.parse(text);
    const e = j.error ?? j.detail ?? j.message;
    return typeof e === "string" ? e : e?.message ?? JSON.stringify(e);
  } catch {
    return text.slice(0, 200);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- cache: one storage.local entry per (question set, comment) -----------------------------------

const cacheKey = (key, id) => `s:${key}:${id}`;

async function readCache(key, ids) {
  const keys = ids.map((id) => cacheKey(key, id));
  const got = await chrome.storage.local.get(keys);
  const now = Date.now();
  const out = new Map();
  for (const id of ids) {
    const e = got[cacheKey(key, id)];
    if (e && now - e.t < CACHE_TTL_MS) out.set(id, e.v);
  }
  return out;
}

async function pruneCache() {
  const all = await chrome.storage.local.get(null);
  const now = Date.now();
  const stale = Object.keys(all).filter((k) => k.startsWith("s:") && !(now - all[k].t < CACHE_TTL_MS));
  if (stale.length) await chrome.storage.local.remove(stale);
}

// Serialised so parallel requests don't overwrite each other's read-modify-write.
let usageChain = Promise.resolve();
function addUsage(tokens, comments) {
  usageChain = usageChain.then(async () => {
    const { usage = { tokens: 0, comments: 0, since: Date.now() } } = await chrome.storage.local.get("usage");
    usage.tokens += tokens;
    usage.comments += comments;
    await chrome.storage.local.set({ usage });
  }).catch(() => {});
  return usageChain;
}

// ---- scoring a page -------------------------------------------------------------------------------

async function scorePage(port, { story, comments }) {
  const abort = new AbortController();
  port.onDisconnect.addListener(() => abort.abort());
  const post = (msg) => {
    if (!abort.signal.aborted) port.postMessage(msg);
  };

  const settings = await HNCF.getSettings();
  const { criteria } = settings;
  const key = HNCF.criteriaKey(criteria);
  post({ type: "start", key, total: comments.length });

  const cached = await readCache(key, comments.map((c) => c.id));
  for (const [id, score] of cached) post({ type: "result", id, score, cached: true });
  const todo = comments.filter((c) => !cached.has(c.id));
  if (!todo.length) return post({ type: "done" });

  let apiKey;
  try {
    apiKey = await getApiKey();
  } catch (e) {
    return post({ type: "fatal", message: e.message });
  }

  // Batches in page order, so the top of the thread is ready first.
  const queue = [];
  for (let i = 0; i < todo.length; i += HNCF.BATCH_SIZE) queue.push(todo.slice(i, i + HNCF.BATCH_SIZE));
  let fatal = null;
  const worker = async () => {
    while (queue.length && !fatal && !abort.signal.aborted) {
      const wait = pausedUntil - Date.now();
      if (wait > 0) {
        // Report the pause in short steps: each message also keeps the service worker from being
        // stopped as idle (after ~30 s) during a long wait.
        post({ type: "paused", until: pausedUntil });
        await sleep(Math.min(wait, 10_000));
        continue;
      }
      const batch = queue.shift();
      try {
        const state = HNCF.buildBatchState(story, batch);
        const r = await systemOne(apiKey, state, HNCF.batchQuestions(criteria, batch.length), abort.signal);
        const t = Date.now();
        const results = batch.map((c, i) => [c.id, HNCF.scoreFromAnswer(r.answers?.[`c${i}`], criteria.levels)]);
        const scored = results.filter(([, score]) => score != null);
        await chrome.storage.local.set(Object.fromEntries(scored.map(([id, v]) => [cacheKey(key, id), { v, t }])));
        await addUsage(r.usage?.input_tokens ?? 0, batch.length);
        for (const [id, score] of results) {
          post(score != null ? { type: "result", id, score } : { type: "error", id, message: "no answer from Jev" });
        }
      } catch (e) {
        if (abort.signal.aborted) return;
        if (e instanceof RateLimited) {
          pausedUntil = Math.max(pausedUntil, Date.now() + e.seconds * 1000);
          queue.unshift(batch);
        } else if (e instanceof FatalError) fatal = e;
        else for (const c of batch) post({ type: "error", id: c.id, message: e.message });
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  post(fatal ? { type: "fatal", message: fatal.message } : { type: "done" });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "score") return;
  port.onMessage.addListener((msg) => {
    if (msg.type === "score") {
      scorePage(port, msg).catch((e) => {
        try {
          port.postMessage({ type: "fatal", message: e.message });
        } catch {}
      });
    }
  });
});

// Options page: test credentials.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === "test-credentials") {
    const state = { story_title: "Test", comment: "I have run Postgres in production for ten years." };
    const questions = { test: { type: "noul", instructions: "Does `comment` describe direct experience?" } };
    systemOne(msg.apiKey, state, questions)
      .then((r) => reply({ ok: true, model: r.model }))
      .catch((e) => reply({ ok: false, message: e.message }));
    return true;
  }
  if (msg.type === "open-options") chrome.runtime.openOptionsPage();
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
// On install or update, drop any stored data this version doesn't use.
async function removeUnusedData() {
  const sync = await chrome.storage.sync.get(null);
  const oldSettings = Object.keys(sync).filter((k) => !(k in HNCF.DEFAULT_SETTINGS));
  if (oldSettings.length) await chrome.storage.sync.remove(oldSettings);
  const local = await chrome.storage.local.get(null);
  const unused = Object.keys(local).filter((k) =>
    k.startsWith("s:") ? typeof local[k].v !== "number" : !["typesafe", "usage"].includes(k),
  );
  if (unused.length) await chrome.storage.local.remove(unused);
}

chrome.runtime.onInstalled.addListener(async () => {
  await removeUnusedData();
  await pruneCache();
});
chrome.runtime.onStartup.addListener(() => pruneCache());
