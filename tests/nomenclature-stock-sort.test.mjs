import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { NomenclatureService } from "../src/backend/nomenclature/nomenclature-service.ts";
import { decodeStockCursor, encodeStockCursor, parseStockSort } from "../src/backend/nomenclature/stock-sort.ts";

const result = (job, products, hasMore, lastSortValue) => ({ requestId: job.id, leaseId: job.leaseId,
  status: "completed", products, hasMore, lastSortValue });
async function fixture(check) {
  const directory = await mkdtemp(join(tmpdir(), "stock-sort-"));
  const path = join(directory, "database.sqlite");
  const service = new NomenclatureService(path);
  const token = service.rotateKey(); service.heartbeat(token);
  try { await check({ service, token }); }
  finally { service.close(); await rm(directory, { recursive: true, force: true }); }
}

test("sorted cursors preserve raw names, empty articles and exact decimals, scoped to search/order", () => {
  const id = randomUUID();
  for (const [field, value] of [["name", " Колодки\r\nтормозные "], ["article", ""], ["quantity", "999999999999999.123456789"]]) {
    const sort = parseStockSort(field, "desc");
    const cursor = encodeStockCursor({ id, value }, "кол тор", sort);
    assert.deepEqual(decodeStockCursor(cursor, "кол тор", sort), { id, value });
    assert.throws(() => decodeStockCursor(cursor, "кол", sort));
    assert.throws(() => decodeStockCursor(cursor, "кол тор", { ...sort, direction: "asc" }));
    assert.throws(() => decodeStockCursor(cursor, "кол тор", { ...sort, field: field === "name" ? "article" : "name" }));
    assert.throws(() => decodeStockCursor(cursor + "=", "кол тор", sort));
  }
  for (const args of [["bad", "asc"], ["quantity", "DROP TABLE"], ["id", "desc"], ["", "asc"]]) assert.throws(() => parseStockSort(...args));
  const sort = parseStockSort("quantity", "asc");
  for (const value of [null, 1, "0", "-1", "NaN", "1,125", "1e16", " 1", "01", "1e999"]) {
    assert.throws(() => decodeStockCursor(encodeStockCursor({ id, value }, "", sort), "", sort));
  }
  const priceSort = parseStockSort("price", "asc");
  const priceValue = JSON.stringify({ hasPrice: true, amount: 1500.5 });
  const priceCursor = encodeStockCursor({ id, value: priceValue }, "", priceSort);
  assert.deepEqual(decodeStockCursor(priceCursor, "", priceSort), { id, value: priceValue });
  for (const value of [JSON.stringify({ hasPrice: false, amount: 1 }), JSON.stringify({ hasPrice: true, amount: -1 }), JSON.stringify({ hasPrice: true, amount: 1e13 }), "null", "{}", "not-json"]) {
    assert.throws(() => decodeStockCursor(encodeStockCursor({ id, value }, "", priceSort), "", priceSort));
  }
});

test("only sorting-aware workers claim sorted pages; queues separate fields and directions", async () => {
  await fixture(async ({ service, token }) => {
    const signal = new AbortController().signal;
    const sorts = ["name", "article", "quantity"].flatMap((field) => ["asc", "desc"].map((direction) => ({ field, direction })));
    const reads = sorts.map((sort) => service.loadStock(null, signal, "кол тор", sort));
    assert.equal(service.claim(token, true, true, true), null);
    const claimed = new Set();
    for (let index = 0; index < sorts.length; index += 1) {
      const job = service.claim(token, true, true, true, true);
      claimed.add(`${job.sortField}:${job.sortDirection}`);
      assert.equal(job.after, null); assert.equal(job.query, "кол тор");
      service.completeStock(token, result(job, [], false, null));
    }
    assert.equal(claimed.size, 6); await Promise.all(reads);
    const legacyId = randomUUID();
    const legacy = service.loadStock(legacyId, signal);
    const job = service.claim(token, true, true, true, true);
    assert.deepEqual(job.after, { id: legacyId, value: null });
    assert.equal(job.sortField, "id"); service.completeStock(token, result(job, [], false, null)); await legacy;
  });
});

test("six global orders paginate 235 products across tied values with one job per page for 100 readers", async () => {
  // Model 1C's source order with stable keys. Locale-specific 1C comparison is a platform check.
  const inventory = Array.from({ length: 235 }, (_, index) => ({ id: randomUUID(), name: `Товар ${Math.floor(index / 130)}`,
    article: index < 130 ? "" : "0000123", quantity: index < 130 ? 1.125 : 9.5 }));
  for (const field of ["name", "article", "quantity"]) for (const direction of ["asc", "desc"]) await fixture(async ({ service, token }) => {
    const sort = { field, direction }; const signal = new AbortController().signal;
    const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
    const expected = [...inventory].sort((a, b) => compare(a[field], b[field]) * (direction === "asc" ? 1 : -1) || compare(a.id, b.id));
    const seen = []; let cursor = null; let jobs = 0;
    do {
      const reads = Array.from({ length: 100 }, () => service.loadStock(cursor, signal, "товар", sort));
      const job = service.claim(token, true, true, true, true); jobs += 1;
      assert.equal(service.claim(token, true, true, true, true), null, "100 readers share one job");
      const offset = job.after ? expected.findIndex((item) => item.id === job.after.id) + 1 : 0;
      assert.equal(offset, seen.length);
      if (job.after) assert.equal(job.after.value, String(expected[offset - 1][field]));
      const products = expected.slice(offset, offset + 100); const hasMore = offset + products.length < expected.length;
      const key = String(products.at(-1)[field]);
      if (hasMore) assert.throws(() => service.completeStock(token, result(job, products, true, undefined)), (error) => error.statusCode === 400);
      const prepare = DatabaseSync.prototype.prepare; let resultReads = 0;
      try {
        DatabaseSync.prototype.prepare = function (sql) {
          if (sql === "SELECT * FROM nomenclature_stock_requests WHERE id=?") resultReads += 1;
          return prepare.call(this, sql);
        };
        service.completeStock(token, result(job, products, hasMore, key));
      } finally { DatabaseSync.prototype.prepare = prepare; }
      assert.equal(resultReads, 1);
      const pages = await Promise.all(reads);
      assert.ok(pages.every((page) => page.nextCursor === pages[0].nextCursor));
      seen.push(...pages[0].products); cursor = pages[0].nextCursor;
    } while (cursor);
    assert.deepEqual(seen, expected); assert.equal(new Set(seen.map((item) => item.id)).size, 235); assert.equal(jobs, 3);
    console.log(`Sorted ${field} ${direction}: 235 items, 3 jobs; 100 readers share 1 result read per page.`);
  });
});
