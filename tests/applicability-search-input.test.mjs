import assert from "node:assert/strict";
import { test } from "node:test";
import { parseApplicabilitySkus, runApplicabilityBatch } from "../src/frontend/applicability-search-input.js";

test("applicability input uses commas and preserves article punctuation and internal spaces", () => {
  assert.deepEqual(parseApplicabilitySkus(" 30676484,30780376, 30780377 ,8687389 "),
    ["30676484", "30780376", "30780377", "8687389"]);
  assert.deepEqual(parseApplicabilitySkus("AP 108/6, 1FA-079, 9.7.9"), ["AP 108/6", "1FA-079", "9.7.9"]);
  assert.deepEqual(parseApplicabilitySkus("30676484 30780376"), ["30676484 30780376"]);
  assert.deepEqual(parseApplicabilitySkus(",  ,"), []);
});

test("applicability input removes normalized duplicates without changing the first spelling", () => {
  assert.deepEqual(parseApplicabilitySkus("1fa-079, 1FA079, AP 108/6, ap1086, 1fa-079,"), ["1fa-079", "AP 108/6"]);
});

test("applicability input rejects invalid and oversized batches before requests", () => {
  assert.throws(() => parseApplicabilitySkus(null));
  assert.throws(() => parseApplicabilitySkus("a".repeat(8193)));
  assert.throws(() => parseApplicabilitySkus("a".repeat(129)), /128/);
  assert.throws(() => parseApplicabilitySkus("---"));
  assert.throws(() => parseApplicabilitySkus("AA\u0000BB"));
  assert.deepEqual(parseApplicabilitySkus("a".repeat(128)), ["a".repeat(128)]);
  const skus = Array.from({ length: 50 }, (_, index) => `SKU${index}`);
  assert.equal(parseApplicabilitySkus(skus.join(",")).length, 50);
  assert.throws(() => parseApplicabilitySkus([...skus, "SKU50"].join(",")), /50/);
});

test("applicability batch bounds concurrency and retains successful results after one failure", async () => {
  const entries = Array.from({ length: 12 }, (_, index) => ({ sku: `SKU${index}` }));
  let active = 0;
  let maximumActive = 0;
  const called = [];
  const failure = new Error("Test integration failure");
  const controller = new AbortController();
  const outcomes = await runApplicabilityBatch(entries, async (entry, signal) => {
    assert.equal(signal, controller.signal);
    called.push(entry);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    if (entry === entries[3]) throw failure;
    return entry.sku;
  }, controller.signal);
  assert.equal(maximumActive, 4);
  assert.equal(active, 0);
  assert.equal(called.length, entries.length);
  assert.deepEqual(outcomes.map(({ entry }) => entry), entries);
  assert.equal(outcomes[3].error, failure);
  assert.equal(outcomes[4].result, "SKU4");
});

test("applicability batch cancels queued requests and awaits active requests", async () => {
  const controller = new AbortController();
  const entries = Array.from({ length: 10 }, (_, index) => index);
  const called = [];
  const outcomes = await runApplicabilityBatch(entries, async (entry, signal) => {
    called.push(entry);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    signal.throwIfAborted();
  }, controller.signal);
  assert.deepEqual(called, [0, 1, 2, 3]);
  assert.equal(outcomes.length, 4);
  assert.ok(outcomes.every(({ error }) => error.name === "AbortError"));
  assert.deepEqual(await runApplicabilityBatch(entries, () => { throw new Error("must not start"); }, controller.signal), []);
});
