import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay, setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import { RealOrderApplicationService } from "../src/backend/application/real-order-application-service.ts";
import { SupplierSessionManager } from "../src/backend/session/session-manager.ts";
import { attachPurchaseReference } from "../src/backend/purchasing/purchase-offer.ts";

// Fictional offers only; no supplier credentials or network calls are used.
const references = {
  armtek: { supplier: "armtek", keyzak: "TEST01" },
  "part-kom": { supplier: "part-kom", makerId: "101", providerId: "202" },
  autopiter: { supplier: "autopiter", detailUid: "fixture-detail", sellerId: "10" },
  rossko: { supplier: "rossko", partGuid: "fixture-guid", stockId: "fixture-stock" },
  "forum-auto": { supplier: "forum-auto", warehouse: "Fixture", gid: "fixture-gid" },
};
function line(supplier, index) {
  const reference = references[supplier];
  return { id: randomUUID(), quantity: 1, reference, result: attachPurchaseReference({
    supplier, article: `CART${index}`, brand: "TEST", title: "Fixture part", price: 100,
    quantity: 10, warehouse: "Fixture", deliveryDate: null, deliveryDateApproximate: false,
    link: "https://example.com/",
  }, reference) };
}
const userCart = () => ["armtek", "armtek", "armtek", "armtek", "armtek", "armtek",
  "part-kom", "part-kom", "part-kom", "autopiter", "autopiter"].map(line);
const key = (supplier, article) => JSON.stringify([supplier, article]);
function complete(query, emit, items) {
  for (const item of items.filter((item) => item.result.article === query.article && item.reference.supplier === query.suppliers[0])) {
    emit({ type: "result", result: attachPurchaseReference({ ...item.result, price: 125 }, item.reference) });
  }
  emit({ type: "supplier_status", supplier: query.suppliers[0], status: "completed" });
}

test("11-line cart benchmark: 6 Armtek, 3 PartKOM, 2 Autopiter", async (t) => {
  const items = userCart();
  const durations = [];
  let peak = 0;
  for (let run = 0; run < 5; run++) {
    let active = 0;
    let calls = 0;
    const service = new RealOrderApplicationService(new SupplierSessionManager(), async (query, emit, signal) => {
      calls++;
      peak = Math.max(peak, ++active);
      try { await delay(40, undefined, { signal }); complete(query, emit, items); }
      finally { active--; }
    });
    const started = performance.now();
    const checked = await service.refresh(items, new AbortController().signal);
    durations.push(Math.round(performance.now() - started));
    assert.equal(calls, 11);
    assert.deepEqual(checked.map((item) => item.id), items.map((item) => item.id));
    assert.ok(checked.every((item) => item.result.price === 125 && !item.refreshIssue));
    assert.equal(active, 0);
  }
  const sorted = durations.toSorted((a, b) => a - b);
  t.diagnostic(JSON.stringify({ simulatedSupplierMs: 40, runsMs: durations, medianMs: sorted[2], peakSearches: peak }));
});

test("cart refresh bounds parallel work, deduplicates offers and preserves order for 11 and 500 lines", async () => {
  for (const count of [11, 500]) {
    const items = count === 11 ? userCart() : Array.from({ length: count }, (_, index) => line(
      ["armtek", "part-kom", "autopiter", "rossko", "forum-auto"][index % 5], index));
    // A second brand of the same article shares one lookup, but must match its own offer.
    const duplicate = structuredClone(items[0]);
    duplicate.id = randomUUID(); duplicate.result.brand = "OTHER";
    if (count === 11) items.push(duplicate);
    const calls = new Map();
    const activeBySupplier = new Map();
    const peaks = new Map();
    let active = 0;
    let peak = 0;
    const service = new RealOrderApplicationService(new SupplierSessionManager(), async (query, emit, signal) => {
      const supplier = query.suppliers[0];
      const lookup = key(supplier, query.article);
      calls.set(lookup, (calls.get(lookup) ?? 0) + 1);
      activeBySupplier.set(supplier, (activeBySupplier.get(supplier) ?? 0) + 1);
      peaks.set(supplier, Math.max(peaks.get(supplier) ?? 0, activeBySupplier.get(supplier)));
      peak = Math.max(peak, ++active);
      try { await nextTurn(undefined, { signal }); complete(query, emit, items); }
      finally { active--; activeBySupplier.set(supplier, activeBySupplier.get(supplier) - 1); }
    });
    const checked = await service.refresh(items, new AbortController().signal);
    assert.equal(calls.size, count);
    assert.ok([...calls.values()].every((calls) => calls === 1));
    assert.equal(peak, 4);
    assert.equal(peaks.get("autopiter"), 1, "Autopiter already fans out requests inside a search");
    assert.ok([...peaks.values()].every((peak) => peak <= 2));
    assert.deepEqual(checked.map((item) => [item.id, item.result.brand, item.result.price, item.refreshIssue]),
      items.map((item) => [item.id, item.result.brand, 125, undefined]));
    assert.equal(active, 0);
  }
});

test("slow Armtek searches do not hold up independent PartKOM and Autopiter lookups", async () => {
  const items = userCart();
  const gate = Promise.withResolvers();
  const started = [];
  const service = new RealOrderApplicationService(new SupplierSessionManager(), async (query, emit) => {
    started.push(query.suppliers[0]);
    if (query.suppliers[0] === "armtek") await gate.promise;
    complete(query, emit, items);
  });
  const pending = service.refresh(items, new AbortController().signal);
  try {
    await nextTurn();
    assert.equal(started.filter((supplier) => supplier === "armtek").length, 2);
    assert.equal(started.filter((supplier) => supplier === "part-kom").length, 3);
    assert.equal(started.filter((supplier) => supplier === "autopiter").length, 2);
  } finally { gate.resolve(); await pending; }
});

test("aborting a refresh stops queued searches and waits for active work to finish", async () => {
  const controller = new AbortController();
  const reason = new Error("fixture cancellation");
  let calls = 0;
  let active = 0;
  const service = new RealOrderApplicationService(new SupplierSessionManager(), async (_query, _emit, signal) => {
    calls++; active++;
    try { await delay(10_000, undefined, { signal }); }
    finally { active--; }
  });
  const pending = service.refresh(userCart(), controller.signal);
  const rejected = assert.rejects(pending, (error) => error === reason);
  assert.equal(calls, 4);
  controller.abort(reason);
  await rejected;
  assert.equal(active, 0);
  assert.equal(calls, 4);
  await assert.rejects(service.refresh(userCart(), controller.signal), (error) => error === reason);
  assert.equal(calls, 4, "an already cancelled refresh starts no work");
});

test("a fatal refresh failure cancels sibling searches and leaves no queued work running", async () => {
  const failure = new Error("unexpected fixture failure");
  let calls = 0;
  let active = 0;
  const service = new RealOrderApplicationService(new SupplierSessionManager(), async (query, _emit, signal) => {
    calls++; active++;
    try {
      await nextTurn(undefined, { signal });
      if (query.article === "CART0") throw failure;
      await delay(10_000, undefined, { signal });
    } finally { active--; }
  });
  await assert.rejects(service.refresh(userCart(), new AbortController().signal), (error) => error === failure);
  assert.equal(active, 0);
  assert.equal(calls, 4);
});
