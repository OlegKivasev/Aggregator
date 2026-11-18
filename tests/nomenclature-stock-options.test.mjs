import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NomenclatureService } from "../src/backend/nomenclature/nomenclature-service.ts";
import { parseStockOptions, stockOptionsKey } from "../src/backend/nomenclature/stock-options.ts";
import { parseStockResult } from "../src/backend/nomenclature/stock-contract.ts";
import { decodeStockCursor, defaultStockSort } from "../src/backend/nomenclature/stock-sort.ts";
const retail = randomUUID();
const types = [{ id: retail, name: "Розничная цена" }];
const item = (quantity = 0, price) => ({ id: randomUUID(), name: "Колодки тормозные", article: "0001", quantity, ...(price === undefined ? {} : { price }) });
const result = (job, products, extra = {}) => ({ requestId: job.id, leaseId: job.leaseId, status: "completed", hasMore: false, products, ...extra });
const metadata = (products) => ({ totalCount: products.length, priceTypes: types });
async function fixture(check) {
  const directory = await mkdtemp(join(tmpdir(), "stock-options-"));
  const path = join(directory, "stock.sqlite");
  const service = new NomenclatureService(path); const token = service.rotateKey(); service.heartbeat(token);
  const claim = () => service.claim(token, true, true, true, true, true);
  claim();
  try { await check({ service, token, claim, path }); }
  finally { service.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
test("stock options use only whitelisted presence and actual UUID price types", () => {
  assert.deepEqual(parseStockOptions(null, null), { availability: "available", priceType: null });
  assert.deepEqual(parseStockOptions("all", retail), { availability: "all", priceType: retail });
  for (const args of [["missing", null], ["absent", "retail"], ["all", ""], ["", null]]) assert.throws(() => parseStockOptions(...args));
  const job = { id: randomUUID(), leaseId: randomUUID() };
  const products = [item(0, null), item(-1, { amount: 0, currency: "RUB", unit: "шт" })];
  const parsed = parseStockResult(result(job, products, metadata(products)), true);
  assert.deepEqual(parsed.products, products);
  for (const price of [{ amount: -1, currency: "RUB" }, { amount: 0, currency: "rub" }, { amount: 5, currency: "RUB", unit: "шт\n" }]) {
    assert.throws(() => parseStockResult(result(job, [item(0, price)]), true));
  }
  assert.throws(() => parseStockResult(result(job, [], { totalCount: -1 }), true));
  assert.throws(() => parseStockResult(result(job, [], { priceTypes: [...types, ...types] }), true));
});
test("availability and prices isolate jobs; old workers cannot silently consume filters", async () => {
  await fixture(async ({ service, token, claim }) => {
    const options = [parseStockOptions("all", null), parseStockOptions("absent", null), parseStockOptions("all", retail)];
    const reads = options.map((option) => service.loadStock(null, new AbortController().signal, "кол тор", defaultStockSort, option));
    assert.equal(service.claim(token, true, true, true, true), null);
    const jobs = options.map(() => claim()); assert.equal(claim(), null);
    assert.deepEqual(new Set(jobs.map((job) => stockOptionsKey(job.options))), new Set(options.map(stockOptionsKey)));
    for (const job of jobs) {
      const products = [item(0, job.options.priceType ? null : undefined), item(-2, job.options.priceType ? { amount: 0, currency: "RUB", unit: "шт" } : undefined)];
      assert.throws(() => service.completeStock(token, result(job, products)), /отбору/);
      assert.throws(() => service.completeStock(token, result(job, products, { ...metadata(products), totalCount: 3 })), /отбору/);
      service.completeStock(token, result(job, products, metadata(products)));
    }
    for (const page of await Promise.all(reads)) { assert.equal(page.totalCount, 2); assert.equal(page.products[0].quantity, 0); }
  });
});
test("filter-scoped cursors accept signed quantity and reject mixing presence, query or price", async () => {
  await fixture(async ({ service, token, claim }) => {
    for (const sort of [defaultStockSort, { field: "quantity", direction: "asc" }]) {
      const options = parseStockOptions("absent", retail);
      const read = service.loadStock(null, new AbortController().signal, "", sort, options);
      const job = claim(); const products = Array.from({ length: 100 }, () => item(-1, null));
      service.completeStock(token, result(job, products, { hasMore: true, lastSortValue: sort.field === "quantity" ? "-1" : null, totalCount: 101, priceTypes: types }));
      const page = await read;
      assert.deepEqual(decodeStockCursor(page.nextCursor, "", sort, stockOptionsKey(options)), { id: products.at(-1).id, value: sort.field === "quantity" ? "-1" : null });
      for (const wrong of [parseStockOptions("all", retail), parseStockOptions("absent", null)]) assert.throws(() => decodeStockCursor(page.nextCursor, "", sort, stockOptionsKey(wrong)));
      assert.throws(() => decodeStockCursor(page.nextCursor, "x", sort, stockOptionsKey(options)));
      const more = service.loadStock(page.nextCursor, new AbortController().signal, "", sort, options); const next = claim();
      assert.throws(() => service.completeStock(token, result(next, [item(1, null)])), /отбору/);
      assert.throws(() => service.completeStock(token, result(next, [item(0, null)], { totalCount: 101, priceTypes: types })), /отбору/);
      service.completeStock(token, result(next, [item(0, null)]));
      const last = await more; assert.equal(last.totalCount, undefined); assert.equal(last.products[0].quantity, 0);
    }
  });
});
test("100 readers share one filtered price page and one stored result read", async () => {
  await fixture(async ({ service, token, claim, path }) => {
    const options = parseStockOptions("all", retail);
    const reads = Array.from({ length: 100 }, () => service.loadStock(null, new AbortController().signal, "кол тор", defaultStockSort, options));
    const job = claim(); assert.equal(claim(), null);
    const products = [item(0, null), item(4, { amount: 1500, currency: "RUB", unit: "комплект" })];
    const original = DatabaseSync.prototype.prepare; let count = 0;
    try {
      DatabaseSync.prototype.prepare = function(sql) { if (sql === "SELECT * FROM nomenclature_stock_requests WHERE id=?") count += 1; return original.call(this, sql); };
      service.completeStock(token, result(job, products, metadata(products)));
      const pages = await Promise.all(reads); assert.ok(pages.every((page) => page === pages[0]));
    } finally { DatabaseSync.prototype.prepare = original; }
    assert.equal(count, 1);
    const inspection = new DatabaseSync(path);
    try { assert.equal(inspection.prepare("SELECT COUNT(*) AS count FROM nomenclature_stock_requests").get().count, 1); }
    finally { inspection.close(); }
    console.log("Stock filters: 100 readers -> 1 shared job, 1 result read; metadata only on initial page, one optional price per product, <=100 products.");
  });
});

test("inventory periods validate calendar dates and scope leases, counts and cursors", async () => {
  const filter = (overrides = {}) => new URLSearchParams({
    inventory: "1", receiptFrom: "2024-02-29", receiptTo: "2024-02-29", receiptSource: "free",
    saleFrom: "2024-02-01", saleTo: "2024-02-29", saleSource: "all", oemPresence: "absent", oemFilterBrand: retail,
    ...overrides,
  });
  for (const overrides of [{ inventory: "0" }, { receiptFrom: "2023-02-29" }, { receiptTo: "2024-02-28" },
    { receiptSource: "" }, { saleTo: "2024-02-30" }, { oemFilterBrand: "Toyota" }, { oemPresence: "all" }]) {
    assert.throws(() => parseStockOptions("all", null, filter(overrides)), { statusCode: 400 });
  }
  const options = parseStockOptions("all", null, filter());
  const different = parseStockOptions("all", null, filter({ receiptTo: "2024-03-01" }));
  assert.deepEqual(options.receipts, { from: "2024-02-29", to: "2024-02-29", source: "free" });
  assert.deepEqual(options.sales, { from: "2024-02-01", to: "2024-02-29", source: "all" });
  assert.equal(options.oemFilterBrand, retail);
  await fixture(async ({ service, token, path }) => {
    const claim = (version) => service.claim(token, ...[1, 2, 3, 4, 5, 6, 7].map((minimum) => version >= minimum));
    claim(6);
    assert.throws(() => service.loadStock(null, new AbortController().signal, "лада гранта", defaultStockSort, options), { code: "stock_unsupported" });
    claim(7);
    const started = performance.now();
    const reads = Array.from({ length: 99 }, () => service.loadStock(null, new AbortController().signal, "лада гранта", defaultStockSort, options));
    const other = service.loadStock(null, new AbortController().signal, "лада гранта", defaultStockSort, different);
    assert.equal(claim(6), null);
    const job = claim(7);
    const otherJob = claim(7);
    assert.equal(claim(7), null);
    assert.deepEqual([job.options, otherJob.options], [options, different]);
    const products = Array.from({ length: 100 }, () => ({ ...item(0), incoming: { original: 100.125, replacement: 1200 } }));
    const response = result(job, products, { hasMore: true, totalCount: 101, priceTypes: [] });
    for (const incoming of [null, { original: -1, replacement: 0 }, { original: 0 }]) {
      assert.throws(() => parseStockResult({ ...response, products: [{ ...products[0], incoming }], hasMore: false }, true), { statusCode: 400 });
    }
    assert.throws(() => service.completeStock(token, { ...response, products: [item(0), ...products.slice(1)] }), { code: "invalid_stock" });
    assert.throws(() => service.completeStock(token, { ...response, products: [{ ...products[0], quantity: -1 }, ...products.slice(1)] }), { code: "invalid_stock" });
    service.completeStock(token, parseStockResult(response, true));
    service.completeStock(token, result(otherJob, [], { totalCount: 0, priceTypes: [] }));
    const [page, ...rest] = await Promise.all(reads);
    assert.ok(rest.every((entry) => entry === page));
    assert.equal((await other).totalCount, 0);
    assert.deepEqual(page.products[0].incoming, products[0].incoming);
    assert.throws(() => decodeStockCursor(page.nextCursor, "лада гранта", defaultStockSort, stockOptionsKey(different)));
    const database = new DatabaseSync(path);
    try { assert.equal(database.prepare("SELECT COUNT(*) AS count FROM nomenclature_stock_requests").get().count, 2); }
    finally { database.close(); }
    console.log(`Inventory periods: 100 reads, 2 distinct filter sets, 2 jobs, ${(performance.now() - started).toFixed(1)} ms in local SQLite.`);
  });
});
