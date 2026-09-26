// npm test  (node --test test/*.test.mjs)
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const HNCF = createRequire(import.meta.url)("../extension/shared.js");
const C = HNCF.DEFAULT_CRITERIA;

test("scoreFromAnswer rescales the expected level to 0..1", () => {
  const levels = ["a", "b", "c", "d"];
  assert.equal(HNCF.scoreFromAnswer({ type: "score", score: 1.5 }, levels), 0.5);
  assert.equal(HNCF.scoreFromAnswer({ type: "score", score: 3 }, levels), 1);
  assert.equal(HNCF.scoreFromAnswer(undefined, levels), null);
  assert.equal(HNCF.scoreFromAnswer({ type: "noul", noul: 0.9 }, levels), null);
});

test("nearestLevel names the level a score is closest to", () => {
  const levels = ["a", "b", "c", "d"];
  assert.equal(HNCF.nearestLevel(0, levels), "a");
  assert.equal(HNCF.nearestLevel(0.6, levels), "c"); // 1.8 of 3
  assert.equal(HNCF.nearestLevel(1, levels), "d");
});

test("criteriaKey changes with the question or the levels", () => {
  const k = HNCF.criteriaKey(C);
  assert.match(k, /^[0-9a-f]{8}$/);
  assert.equal(HNCF.criteriaKey({ ...C }), k);
  assert.notEqual(HNCF.criteriaKey({ ...C, question: C.question + "?" }), k);
  assert.notEqual(HNCF.criteriaKey({ ...C, levels: [...C.levels].reverse() }), k);
});

test("buildBatchState puts each comment in its own slot and truncates long text", () => {
  const s = HNCF.buildBatchState({ title: "T" }, [{ text: "x".repeat(10000), parentText: null }, { text: "b", parentText: "p" }]);
  assert.deepEqual(Object.keys(s), ["story_title", "comments"]);
  assert.equal(s.comments.c0.comment.length, 6000);
  assert.deepEqual(Object.keys(s.comments.c0), ["comment"]);
  assert.deepEqual(s.comments.c1, { parent_excerpt: "p", comment: "b" });
  const full = HNCF.buildBatchState({ title: "T", url: "https://e.com", text: "ask" }, [{ text: "c" }]);
  assert.deepEqual(Object.keys(full), ["story_title", "story_url", "story_text", "comments"]);
});

test("batchQuestions asks one score question per slot, pointing references at that slot", () => {
  const criteria = {
    question: "Does `comment` answer `parent_excerpt` about `story_title`?",
    levels: ["no, repeats `parent_excerpt`", "yes"],
  };
  const out = HNCF.batchQuestions(criteria, 2);
  assert.deepEqual(Object.keys(out), ["c0", "c1"]);
  assert.deepEqual(out.c1, {
    type: "score",
    instructions: "Does `comments.c1.comment` answer `comments.c1.parent_excerpt` about `story_title`?",
    criteria: ["no, repeats `comments.c1.parent_excerpt`", "yes"],
  });
  // Inputs are not mutated.
  assert.equal(criteria.question, "Does `comment` answer `parent_excerpt` about `story_title`?");
  assert.deepEqual(criteria.levels, ["no, repeats `parent_excerpt`", "yes"]);
});

test("keptDescendants finds kept comments anywhere in each subtree", () => {
  // 0 A          filtered, grandchild kept
  // 1   B        filtered, child kept
  // 2     C      kept
  // 1   D        filtered, no kept replies
  // 0 E          filtered
  // 1   F        kept
  // 0 G          kept
  const depths = [0, 1, 2, 1, 0, 1, 0];
  const kept = [false, false, true, false, false, true, true];
  assert.deepEqual(HNCF.keptDescendants(depths, kept), [true, true, false, false, true, false, false]);
});

test("keptDescendants does not leak a sibling subtree into the next parent", () => {
  // 0 A, 1 B (kept), 0 C, 1 D (filtered): C must not see B.
  assert.deepEqual(HNCF.keptDescendants([0, 1, 0, 1], [false, true, false, false]), [true, false, false, false]);
});

test("validateCriteria accepts the defaults and reports bad input", () => {
  assert.deepEqual(HNCF.validateCriteria(C), []);
  assert.equal(HNCF.validateCriteria({ question: "", levels: ["a", "b"] }).length, 1);
  assert.match(HNCF.validateCriteria({ question: "Is it good?", levels: ["a", "b"] })[0], /`comment`/);
  assert.match(HNCF.validateCriteria({ question: "Is `comment` good?", levels: ["only"] })[0], /2–10 levels/);
  assert.equal(HNCF.validateCriteria({ question: "Is `comment` good?", levels: Array(11).fill("x") }).length, 1);
});

// Page order: A(0) B(1) C(2) D(1) E(0) F(1) G(0)
const tree = () => {
  const items = [["A", 0], ["B", 1], ["C", 2], ["D", 1], ["E", 0], ["F", 1], ["G", 0]].map(([id, depth]) => ({ id, depth }));
  return { items, roots: HNCF.linkTree(items) };
};

test("linkTree builds parent/child links from depths", () => {
  const { items, roots } = tree();
  assert.deepEqual(roots.map((n) => n.id), ["A", "E", "G"]);
  assert.deepEqual(items[0].children.map((n) => n.id), ["B", "D"]);
  assert.deepEqual(items[1].children.map((n) => n.id), ["C"]);
  assert.deepEqual(items[6].children, []);
});

test("sortedPreorder sorts siblings best first and keeps replies under their parent", () => {
  const { roots } = tree();
  const score = { A: 0.3, B: 0.2, C: 0.9, D: 0.8, E: 0.7, F: 0.1, G: 0.5 };
  const order = HNCF.sortedPreorder(roots, (n) => score[n.id]).map((n) => n.id);
  assert.deepEqual(order, ["E", "F", "G", "A", "D", "B", "C"]);
});

test("sortedPreorder ranks unscored items by their best reply, else last, and keeps ties in page order", () => {
  const { roots } = tree();
  // A is deleted (no score): it ranks by its best direct reply (B, D: 0.2), so below E (0.5).
  // B and D tie and keep page order. G is unscored with no replies, so it goes last.
  const score = { B: 0.2, C: 0.9, D: 0.2, E: 0.5, F: 0.1 };
  const order = HNCF.sortedPreorder(roots, (n) => score[n.id]).map((n) => n.id);
  assert.deepEqual(order, ["E", "F", "A", "B", "C", "D", "G"]);
});

test("sortedPreorder output is a valid page order: every reply directly follows its parent's subtree start", () => {
  const { items, roots } = tree();
  const order = HNCF.sortedPreorder(roots, () => Math.random());
  assert.equal(order.length, items.length);
  // Depths never jump by more than one going down, and each item's parent is the last shallower item.
  order.forEach((n, i) => {
    if (n.depth === 0) return;
    const parent = order.slice(0, i).reverse().find((m) => m.depth === n.depth - 1);
    assert.ok(parent.children.includes(n), `${n.id} is not under its parent`);
  });
});

test("layout keeps filtered parents of kept replies as context and folds the rest into groups", () => {
  // 0 A  filtered, has kept grandchild -> context
  // 1   B  filtered, kept child        -> context
  // 2     C  kept
  // 2     D  filtered                  -> folded (group 1)
  // 3       E  filtered                -> folded (inside D's branch, same group)
  // 2     F  filtered                  -> folded (sibling of D, same group)
  // 1   G  kept
  // 0 H  filtered                      -> folded (group 2, new parent level)
  // 1   I  filtered                    -> folded (inside H)
  // 0 J  filtered                      -> folded (sibling of H, same group)
  const depths = [0, 1, 2, 2, 3, 2, 1, 0, 1, 0];
  const kept = [false, false, true, false, false, false, true, false, false, false];
  const { states, groups } = HNCF.layout(depths, kept);
  assert.deepEqual(states, ["context", "context", "kept", "folded", "folded", "folded", "kept", "folded", "folded", "folded"]);
  assert.deepEqual(groups, [
    { start: 3, end: 6, depth: 2, count: 3 },
    { start: 7, end: 10, depth: 0, count: 3 },
  ]);
});

test("layout starts a new group when a shallower folded comment follows a deeper group", () => {
  // 0 A kept; 1 B folded; 0 C folded — B and C have different parents, so two groups.
  const { groups } = HNCF.layout([0, 1, 0], [true, false, false]);
  assert.deepEqual(groups.map((g) => [g.start, g.end]), [[1, 2], [2, 3]]);
});

test("bestInBranch finds the highest score in a branch, ignoring unscored items", () => {
  const { roots } = tree();
  const score = { A: 0.3, B: 0.2, C: 0.9, E: 0.4 };
  const best = (id) => HNCF.bestInBranch(roots.find((n) => n.id === id), (n) => score[n.id]);
  assert.equal(best("A"), 0.9); // C is A's grandchild
  assert.equal(best("E"), 0.4);
  assert.equal(best("G"), null);
});
