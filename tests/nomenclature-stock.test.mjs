import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { NomenclatureService } from "../src/backend/nomenclature/nomenclature-service.ts";
import { parseStockResult } from "../src/backend/nomenclature/stock-contract.ts";
import { createAggregatorServer } from "../src/backend/http/create-server.ts";

const product = { id: randomUUID(), name: "Товар", article: "0000123", quantity: 1.125 };
const result = (job, products = [product], hasMore = false) => ({ requestId: job.id, leaseId: job.leaseId, status: "completed", products, hasMore });
const json = (body, headers = {}) => ({ headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const rejection = (promise) => { promise.catch(() => {}); return promise; };
async function fixture(check) {
  const directory = await mkdtemp(join(tmpdir(), "nomenclature-stock-"));
  const path = join(directory, "stock.sqlite");
  let now = Date.now();
  const service = new NomenclatureService(path, () => now);
  const token = service.rotateKey();
  service.heartbeat(token);
  try { await check({ service, token, path, advance: (milliseconds) => { now += milliseconds; } }); }
  finally { service.close(); await rm(directory, { recursive: true, force: true }); }
}

test("stock validates bounded complete pages, positive quantities and unmodified articles", () => {
  const valid = result({ id: randomUUID(), leaseId: randomUUID() });
  assert.equal(parseStockResult(valid).products[0].article, "0000123");
  assert.equal(parseStockResult({ ...valid, products: [{ ...product, article: "" }] }).products[0].article, "");
  for (const data of [
    { ...valid, extra: true }, { ...valid, status: "found" }, { ...valid, status: "error" },
    { ...valid, hasMore: true }, { ...valid, products: [product, product] },
    { ...valid, products: Array.from({ length: 101 }, () => ({ ...product, id: randomUUID() })) },
    ...[0, -1, NaN, Infinity, 1e16, "1"].map((quantity) => ({ ...valid, products: [{ ...product, quantity }] })),
    ...[{ article: "A\nB" }, { article: "A".repeat(51) }, { name: " " }, { name: "A\u0000B" }, { id: "invalid" }, { prices: {} }]
      .map((fields) => ({ ...valid, products: [{ ...product, ...fields }] })),
  ]) assert.throws(() => parseStockResult(data));
  assert.deepEqual(parseStockResult({ ...valid, status: "error", products: [] }).products, []);
});

test("1, 10 and 100 concurrent readers share one 1C job per page, with fresh later reads", async () => {
  for (const count of [1, 10, 100]) await fixture(async ({ service, token, path }) => {
    const abort = new AbortController();
    const reads = Array.from({ length: count }, () => service.loadStock(null, abort.signal));
    if (count === 100) await assert.rejects(service.loadStock(null, abort.signal), (error) => error.statusCode === 429);
    assert.equal(service.claim(token), null, "old extensions cannot take stock jobs");
    const job = service.claim(token, true);
    assert.equal(job.kind, "stock"); assert.equal(job.limit, 100); assert.equal(job.after, null);
    assert.equal(service.claim(token, true), null);
    const products = Array.from({ length: 100 }, () => ({ ...product, id: randomUUID() }));
    const prepare = DatabaseSync.prototype.prepare;
    let resultReads = 0;
    let pages;
    try {
      DatabaseSync.prototype.prepare = function (sql) {
        if (sql === "SELECT * FROM nomenclature_stock_requests WHERE id=?") resultReads += 1;
        return prepare.call(this, sql);
      };
      service.completeStock(token, result(job, products, true));
      pages = await Promise.all(reads);
    } finally { DatabaseSync.prototype.prepare = prepare; }
    assert.equal(resultReads, 1, "delivery reads the result row once, independent of reader count");
    for (const page of pages) {
      assert.deepEqual(page.products, products);
      assert.equal(page.hasMore, true);
      assert.equal(page.nextCursor, products.at(-1).id);
    }
    service.completeStock(token, result(job, products, true));
    assert.throws(() => service.completeStock(token, result(job)), (error) => error.statusCode === 409);
    const next = service.loadStock(pages[0].nextCursor, abort.signal);
    const nextJob = service.claim(token, true);
    assert.equal(nextJob.after, products.at(-1).id);
    service.completeStock(token, result(nextJob, []));
    assert.deepEqual((await next).products, []);
    const fresh = service.loadStock(null, abort.signal);
    const freshJob = service.claim(token, true);
    assert.notEqual(freshJob.id, job.id);
    service.completeStock(token, result(freshJob));
    assert.equal((await fresh).products.length, 1);
    const database = new DatabaseSync(path);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM nomenclature_stock_requests").get().count, 3,
      "three pages require three 1C jobs independent of reader count");
    database.close();
    console.log(`Stock ${count} readers: 1 shared initial job, 1 result read, 100 rows; next page and refresh each add 1 job.`);
  });
});

test("a reader leaving preserves shared work; the last departure cancels it and rejects late delivery", async () => {
  await fixture(async ({ service, token }) => {
    const first = new AbortController(); const second = new AbortController();
    const a = rejection(service.loadStock(null, first.signal));
    const b = service.loadStock(null, second.signal);
    const job = service.claim(token, true);
    first.abort(); await assert.rejects(a, { name: "AbortError" });
    service.completeStock(token, result(job));
    assert.equal((await b).products.length, 1);
    const last = new AbortController();
    const c = rejection(service.loadStock(null, last.signal));
    const cancelled = service.claim(token, true);
    last.abort(); await assert.rejects(c);
    assert.throws(() => service.completeStock(token, result(cancelled)), (error) => error.statusCode === 409);
    assert.equal(service.claim(token, true), null);
  });
});

test("leases, expiry, source errors and key replacement never yield a partial stock page", async () => {
  await fixture(async ({ service, token, advance }) => {
    const abort = new AbortController();
    const read = rejection(service.loadStock(null, abort.signal));
    const first = service.claim(token, true);
    advance(10_001);
    const second = service.claim(token, true);
    assert.equal(second.id, first.id); assert.notEqual(second.leaseId, first.leaseId);
    assert.throws(() => service.completeStock(token, result(first)), (error) => error.statusCode === 409);
    service.completeStock(token, { ...result(second, []), status: "error" });
    await assert.rejects(read, (error) => error.statusCode === 503);
    const revoked = rejection(service.loadStock(null, abort.signal));
    const revokedJob = service.claim(token, true);
    const replacement = service.rotateKey();
    await assert.rejects(revoked, (error) => error.statusCode === 503);
    assert.throws(() => service.completeStock(token, result(revokedJob)), (error) => error.statusCode === 401);
    assert.throws(() => service.loadStock(null, abort.signal), (error) => error.code === "source_offline");
    service.heartbeat(replacement);
    const expired = rejection(service.loadStock(null, abort.signal));
    const expiredJob = service.claim(replacement, true);
    advance(30_001);
    assert.throws(() => service.completeStock(replacement, result(expiredJob)), (error) => error.statusCode === 409);
    abort.abort(); await assert.rejects(expired);
  });
});

test("different pages have a bounded queue and all abandoned requests release their slots", async () => {
  await fixture(async ({ service, token }) => {
    const abort = new AbortController();
    const reads = Array.from({ length: 20 }, () => rejection(service.loadStock(randomUUID(), abort.signal)));
    await assert.rejects(service.loadStock(randomUUID(), abort.signal), (error) => error.statusCode === 429);
    abort.abort();
    await Promise.allSettled(reads);
    assert.equal(service.claim(token, true), null);
    const fresh = service.loadStock(null, new AbortController().signal);
    service.completeStock(token, result(service.claim(token, true), []));
    assert.equal((await fresh).hasMore, false);
  });
});

test("scans and stock pages share FIFO ordering and shutdown releases waiting browsers", async () => {
  await fixture(async ({ service, token, advance }) => {
    const abort = new AbortController();
    const read = rejection(service.loadStock(null, abort.signal));
    advance(1);
    const lookup = service.create("123", "employee");
    const stock = service.claim(token, true);
    assert.equal(stock.kind, "stock");
    service.completeStock(token, result(stock, []));
    await read;
    const scan = service.claim(token, true);
    assert.equal(scan.id, lookup.id);
    service.complete(token, { requestId: scan.id, leaseId: scan.leaseId, status: "not_found", products: [] });
    const waiting = rejection(service.loadStock(null, abort.signal));
    service.close();
    await assert.rejects(waiting, (error) => error.code === "stopping");
    assert.throws(() => service.loadStock(null, abort.signal), (error) => error.code === "stopping");
  });
});

test("HTTP delivers stock in one waiting browser request and keeps old worker protocol intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nomenclature-stock-http-"));
  const previous = process.env.GARAGE_DB_PATH;
  process.env.GARAGE_DB_PATH = join(directory, "database.sqlite");
  const server = createAggregatorServer({ application: { streamSearch: async () => {} }, publicDir: resolve("src/frontend") });
  try {
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    const request = (path, options) => fetch(`http://127.0.0.1:${server.address().port}${path}`, options);
    assert.equal((await request("/api/nomenclature/stock")).status, 503);
    const token = (await (await request("/api/nomenclature/connection", { method: "POST", ...json({}) })).json()).token;
    const headers = { Authorization: `Bearer ${token}` };
    const poll = async (stock = "") => (await (await request(`/api/integration/1c/nomenclature/requests?waitSeconds=0${stock}`, { headers })).json()).request;
    await poll();
    const waiting = request("/api/nomenclature/stock");
    let job;
    for (let i = 0; i < 100 && !job; i += 1) job = await poll("&stock=1");
    assert.ok(job); assert.equal(job.kind, "stock");
    assert.equal(await poll(), null);
    assert.equal((await request("/api/integration/1c/nomenclature/stock-results", { method: "POST", ...json(result(job)) })).status, 401);
    assert.equal((await request("/api/integration/1c/nomenclature/stock-results", { method: "POST", ...json(result(job, [{ ...product, quantity: 0 }]), headers) })).status, 400);
    assert.equal((await request("/api/integration/1c/nomenclature/stock-results", { method: "POST", ...json(result(job), headers) })).status, 200);
    const response = await waiting;
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual((await response.json()).products, [product]);
    for (const query of ["?after=wrong", "?after=", `?after=${product.id}&after=${product.id}`, "?limit=10000"]) {
      assert.equal((await request("/api/nomenclature/stock" + query)).status, 400);
    }
    assert.equal((await request("/api/nomenclature/stock", { method: "POST", ...json({}) })).status, 405);
    assert.equal((await request("/api/integration/1c/nomenclature/requests?stock=2", { headers })).status, 400);
  } finally {
    server.closeAllConnections(); await new Promise((done) => server.close(done));
    if (previous === undefined) delete process.env.GARAGE_DB_PATH; else process.env.GARAGE_DB_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
