import assert from "node:assert/strict";
import { test } from "node:test";
import { addSearchHistoryEntry, normalizeSearchHistory, searchHistoryLimit } from "../src/frontend/search-history.js";

test("pricing history keeps the latest query first without changing its spelling", () => {
  let history = addSearchHistoryEntry([], { query: " A-1 " }, "pricing");
  history = addSearchHistoryEntry(history, { query: "B2" }, "pricing");
  history = addSearchHistoryEntry(history, { query: "a-1" }, "pricing");
  assert.deepEqual(history, [{ query: "a-1", brands: [] }, { query: "B2", brands: [] }]);
  history = normalizeSearchHistory(Array.from({ length: 150 }, (_, index) => ({ query: `A${index}` })), "pricing");
  assert.equal(history.length, searchHistoryLimit);
  assert.equal(history[0].query, "A0");
  assert.equal(history.at(-1).query, "A29");
});

test("both histories retain 30 recent requests and replace the oldest on every overflow", () => {
  assert.equal(searchHistoryLimit, 30);
  for (const kind of ["pricing", "applicability"]) {
    let history = [];
    for (let index = 0; index < 65; index++) {
      history = addSearchHistoryEntry(history, { query: `A${index}`, brands: ["FORD"] }, kind);
      assert.equal(history.length, Math.min(index + 1, 30));
      assert.equal(history[0].query, `A${index}`);
      assert.equal(history.at(-1).query, `A${Math.max(0, index - 29)}`);
    }
    history = addSearchHistoryEntry(history, history.at(-1), kind);
    assert.equal(history.length, 30);
    assert.equal(history[0].query, "A35");
    assert.equal(history.at(-1).query, "A36");
  }
});

test("applicability history restores multiple articles and brands and deduplicates equivalent requests", () => {
  let history = addSearchHistoryEntry([], { query: "A-1, B2", brands: ["FORD", "BMW"] }, "applicability");
  history = addSearchHistoryEntry(history, { query: "B2, a1", brands: ["bmw", "Ford", "FORD"] }, "applicability");
  assert.deepEqual(history, [{ query: "B2, a1", brands: ["bmw", "FORD"] }]);
  history = addSearchHistoryEntry(history, { query: "B2, a1", brands: ["VW"] }, "applicability");
  assert.equal(history.length, 2, "different brand selections remain separate searches");
});

test("corrupt, unbounded and control-character history entries are discarded", () => {
  for (const kind of ["pricing", "applicability"]) {
    for (const value of [null, {}, "[]", false]) assert.deepEqual(normalizeSearchHistory(value, kind), []);
    assert.deepEqual(normalizeSearchHistory([null, {}, { query: 1 }, { query: "" }, { query: "A\n1" }, { query: "A".repeat(8193) }], kind), []);
  }
  for (const entry of [
    { query: "A".repeat(129) }, { query: ",,,", brands: ["FORD"] },
    { query: "A1", brands: [] }, { query: "A1", brands: "FORD" },
    { query: "A1", brands: [null] }, { query: "A1", brands: ["FORD\nBMW"] },
    { query: "A1", brands: ["A".repeat(129)] },
  ]) assert.deepEqual(normalizeSearchHistory([entry], "applicability"), []);
  assert.equal(normalizeSearchHistory([{ query: "A".repeat(129) }], "pricing").length, 0);
  assert.deepEqual(normalizeSearchHistory([{ query: '<img src=x onerror="alert(1)">', brands: ["FORD"] }], "applicability")[0].brands, ["FORD"]);
});
