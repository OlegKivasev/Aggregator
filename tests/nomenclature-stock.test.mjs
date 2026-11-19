import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { NomenclatureService } from "../src/backend/nomenclature/nomenclature-service.ts";
import { parseStockResult, parseStockQuery } from "../src/backend/nomenclature/stock-contract.ts";
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
  service.claim(token, true, true, true, true, true);
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

test("inventory breakdown accepts zero rows and validates the displayed sum", () => {
  const replacement = { name: "Деталь", article: "0000007", quantity: 7 };
  const stockDetails = { original: 5, replacements: [replacement, { ...replacement, quantity: 0 }] };
  const data = result({ id: randomUUID(), leaseId: randomUUID() }, [{ ...product, quantity: 12, stockDetails }]);
  assert.deepEqual(parseStockResult(data).products[0].stockDetails, stockDetails);
  for (const details of [
    { ...stockDetails, original: 4 },
    { ...stockDetails, replacements: [{ ...replacement, quantity: -7 }] },
    { ...stockDetails, replacements: [{ ...replacement, name: "Деталь\n" }] },
  ]) assert.throws(() => parseStockResult({ ...data, products: [{ ...data.products[0], stockDetails: details }] }));
  const zero = { original: 0, replacements: [] };
  assert.deepEqual(parseStockResult({ ...data, products: [{ ...product, quantity: 0, stockDetails: zero }] }, true).products[0].stockDetails, zero);
});

test("search normalizes bounded text and shares only identical search/cursor combinations", async () => {
  assert.equal(parseStockQuery("  ФИЛЬТР   00001  "), "00001 фильтр");
  assert.equal(parseStockQuery("%_[~]"), "%_[~]");
  assert.equal(parseStockQuery(" тор  КОЛ кол "), "кол тор");
  for (const value of [null, 1, "x".repeat(101), "İ".repeat(100), "a\nb", "a\u0000b"]) assert.throws(() => parseStockQuery(value));
  await fixture(async ({ service, token }) => {
    const signal = new AbortController().signal;
    const first = service.loadStock(null, signal, "фильтр");
    const shared = service.loadStock(null, signal, "фильтр");
    const other = service.loadStock(null, signal, "00001");
    assert.equal(service.claim(token, true), null, "stock=1 must never silently ignore a search filter");
    const unfiltered = service.loadStock(null, signal);
    const legacyJob = service.claim(token, true);
    assert.equal(Object.hasOwn(legacyJob, "query"), false);
    service.completeStock(token, result(legacyJob, [])); await unfiltered;
    const jobs = [service.claim(token, true, true), service.claim(token, true, true)];
    assert.deepEqual(new Set(jobs.map((job) => job.query)), new Set(["фильтр", "00001"]));
    assert.equal(service.claim(token, true, true), null);
    for (const job of jobs) service.completeStock(token, result(job, [{ ...product, name: job.query }]));
    assert.equal((await first).products[0].name, "фильтр");
    assert.equal((await shared).products[0].name, "фильтр");
    assert.equal((await other).products[0].name, "00001");
  });
});

test("fragment search is shared in either order and requires a worker that supports all fragments", async () => {
  await fixture(async ({ service, token }) => {
    const signal = new AbortController().signal;
    const a = service.loadStock(null, signal, parseStockQuery("кол тор"));
    const b = service.loadStock(null, signal, parseStockQuery("ТОР кол кол"));
    assert.equal(service.claim(token, true, true), null, "a phrase-only worker cannot consume multi-fragment search");
    const job = service.claim(token, true, true, true);
    assert.equal(job.query, "кол тор");
    assert.equal(service.claim(token, true, true, true), null);
    const matching = ["Тормозные колодки", "Колодки тормозные"].map((name) => ({ ...product, id: randomUUID(), name }));
    service.completeStock(token, result(job, matching));
    assert.deepEqual((await a).products, matching); assert.deepEqual((await b).products, matching);
  });
});

test("the initial stock schema migrates without losing results or mixing searches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stock-search-migration-"));
  const path = join(directory, "database.sqlite");
  const database = new DatabaseSync(path);
  database.exec(`CREATE TABLE nomenclature_stock_requests (id TEXT PRIMARY KEY, cursor TEXT NOT NULL, status TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, lease_id TEXT, lease_until INTEGER, result_json TEXT) STRICT;
    CREATE UNIQUE INDEX nomenclature_stock_active_idx ON nomenclature_stock_requests(cursor) WHERE status IN ('pending','leased');`);
  database.prepare("INSERT INTO nomenclature_stock_requests VALUES ('old','','completed',?,?,NULL,NULL,?)").run(Date.now(), Date.now() + 30_000, '{"old":true}');
  database.close();
  const service = new NomenclatureService(path);
  try {
    const inspection = new DatabaseSync(path);
    assert.equal(inspection.prepare("SELECT query FROM nomenclature_stock_requests WHERE id='old'").get().query, "");
    assert.equal(inspection.prepare("SELECT result_json FROM nomenclature_stock_requests WHERE id='old'").get().result_json, '{"old":true}');
    assert.deepEqual(inspection.prepare("PRAGMA index_info(nomenclature_stock_options_active_idx)").all().map((row) => row.name), ["cursor", "query", "sort_field", "sort_direction", "options"]);
    inspection.close();
    const token = service.rotateKey(); service.heartbeat(token);
    const a = service.loadStock(null, new AbortController().signal, "a");
    const b = service.loadStock(null, new AbortController().signal, "b");
    for (let index = 0; index < 2; index += 1) service.completeStock(token, result(service.claim(token, true, true), []));
    await Promise.all([a, b]);
  } finally { service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("1, 10 and 100 concurrent readers share one job per search/page, with fresh later reads", async () => {
  for (const query of ["", "фильтр", "кол тор"]) for (const count of [1, 10, 100]) await fixture(async ({ service, token, path }) => {
    const abort = new AbortController();
    const reads = Array.from({ length: count }, () => service.loadStock(null, abort.signal, query));
    if (count === 100) await assert.rejects(service.loadStock(null, abort.signal, query), (error) => error.statusCode === 429);
    assert.equal(service.claim(token), null, "old extensions cannot take stock jobs");
    const job = service.claim(token, true, true, true);
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
    const next = service.loadStock(pages[0].nextCursor, abort.signal, query);
    const nextJob = service.claim(token, true, true, true);
    assert.equal(nextJob.after, products.at(-1).id);
    service.completeStock(token, result(nextJob, []));
    assert.deepEqual((await next).products, []);
    const fresh = service.loadStock(null, abort.signal, query);
    const freshJob = service.claim(token, true, true, true);
    assert.notEqual(freshJob.id, job.id);
    service.completeStock(token, result(freshJob));
    assert.equal((await fresh).products.length, 1);
    const database = new DatabaseSync(path);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM nomenclature_stock_requests").get().count, 3,
      "three pages require three 1C jobs independent of reader count");
    database.close();
    console.log(`Stock ${count} readers (${query || "all"}): 1 shared initial job, 1 result read, 100 rows; next page and refresh each add 1 job.`);
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
    await poll("&stock=5");
    const status = await (await request("/api/integration/1c/nomenclature/status", { headers })).json();
    assert.equal(status.stockVersion, 5); assert.equal(status.stockReady, false);
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
    const searchResponse = request("/api/nomenclature/stock?q=" + encodeURIComponent("  ФИЛЬТР %_[~] "));
    let searchJob;
    for (let index = 0; index < 100 && !searchJob; index += 1) searchJob = await poll("&stock=3");
    assert.equal(searchJob.query, "%_[~] фильтр");
    assert.equal((await request("/api/integration/1c/nomenclature/stock-results", { method: "POST", ...json(result(searchJob), headers) })).status, 200);
    assert.equal((await searchResponse).status, 200);
    const sortedResponse = request("/api/nomenclature/stock?q=" + encodeURIComponent("кол тор") + "&sort=quantity&direction=desc");
    let sortedJob;
    for (let index = 0; index < 100 && !sortedJob; index += 1) sortedJob = await poll("&stock=4");
    assert.equal(sortedJob.sortField, "quantity"); assert.equal(sortedJob.sortDirection, "desc"); assert.equal(sortedJob.after, null);
    const sortedProducts = Array.from({ length: 100 }, () => ({ ...product, id: randomUUID() }));
    const sortedResult = { ...result(sortedJob, sortedProducts, true), lastSortValue: "1.125" };
    assert.equal((await request("/api/integration/1c/nomenclature/stock-results", { method: "POST", ...json(sortedResult, headers) })).status, 200);
    const sortedPage = await (await sortedResponse).json();
    const nextResponse = request("/api/nomenclature/stock?q=" + encodeURIComponent("ТОР кол") + "&sort=quantity&direction=desc&after=" + sortedPage.nextCursor);
    let nextJob;
    for (let index = 0; index < 100 && !nextJob; index += 1) nextJob = await poll("&stock=4");
    assert.deepEqual(nextJob.after, { id: sortedProducts.at(-1).id, value: "1.125" });
    assert.equal(await poll("&stock=3"), null);
    assert.equal((await request("/api/integration/1c/nomenclature/stock-results", { method: "POST", ...json(result(nextJob, []), headers) })).status, 200);
    assert.equal((await nextResponse).status, 200);
    const priceType = randomUUID();
    const detailedResponse = request(`/api/nomenclature/stock?details=1&availability=all&priceType=${priceType}`);
    let detailed;
    for (let index = 0; index < 100 && !detailed; index += 1) detailed = await poll("&stock=5");
    assert.deepEqual(detailed.options, { availability: "all", priceType });
    assert.equal(await poll("&stock=4"), null);
    const pricedProducts = [{ ...product, quantity: 0, price: null }, { ...product, id: randomUUID(), quantity: -2, price: { amount: 0, currency: "RUB", unit: "шт" } }];
    assert.equal((await request("/api/integration/1c/nomenclature/stock-results", { method: "POST", ...json({ ...result(detailed, pricedProducts), totalCount: 2,
      priceTypes: [{ id: priceType, name: "Розничная цена" }] }, headers) })).status, 200);
    const detailedPage = await (await detailedResponse).json();
    assert.deepEqual(detailedPage.products, pricedProducts); assert.equal(detailedPage.totalCount, 2);
    for (const query of ["?after=wrong", "?after=", `?after=${product.id}&after=${product.id}`, "?limit=10000", "?q=a&q=b", "?q=" + "a".repeat(101), "?q=a%0Ab",
      "?sort=unknown", "?sort=name&sort=quantity", "?sort=quantity&direction=desc&direction=asc", "?direction=desc", "?sort=quantity&direction=unknown",
      `?sort=quantity&direction=asc&after=${sortedPage.nextCursor}`, `?sort=quantity&direction=desc&after=${sortedPage.nextCursor}`,
      "?availability=all", "?details=0", "?details=1&details=1", "?details=1&availability=missing", "?details=1&availability=all&availability=absent",
      "?details=1&priceType=retail", `?priceType=${priceType}`]) {
      assert.equal((await request("/api/nomenclature/stock" + query)).status, 400);
    }
    assert.equal((await request("/api/nomenclature/stock", { method: "POST", ...json({}) })).status, 405);
    assert.equal((await request("/api/integration/1c/nomenclature/requests?waitSeconds=0&stock=11", { headers })).status, 400);
    assert.equal((await request("/api/integration/1c/nomenclature/requests?waitSeconds=0&stock=8", { headers })).status, 200);
    const latest = await (await request("/api/integration/1c/nomenclature/status", { headers })).json();
    assert.equal(latest.stockVersion, 8);
    assert.equal(latest.stockReady, true);
  } finally {
    server.closeAllConnections(); await new Promise((done) => server.close(done));
    if (previous === undefined) delete process.env.GARAGE_DB_PATH; else process.env.GARAGE_DB_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
