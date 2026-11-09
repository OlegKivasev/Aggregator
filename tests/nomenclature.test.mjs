import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createAggregatorServer } from "../src/backend/http/create-server.ts";
import { UserAuthService } from "../src/backend/auth/user-auth-service.ts";
import { NomenclatureService } from "../src/backend/nomenclature/nomenclature-service.ts";
import { parseLookupResult } from "../src/backend/nomenclature/contract.ts";

const product = { id: "12345678-abcd-1234-abcd-123456789abc", name: "Тестовый товар", characteristicId: null, characteristicName: null,
  prices: { purchase: { amount: 0, currency: "RUB" }, retail: { amount: 1234.5, currency: "RUB" }, retailCashless: null } };
const json = (body, headers = {}) => ({ headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
async function withServer(check, enableAuth = false) {
  const directory = await mkdtemp(join(tmpdir(), "aggregator-nomenclature-api-"));
  const previousPath = process.env.GARAGE_DB_PATH;
  const path = join(directory, "database.sqlite");
  process.env.GARAGE_DB_PATH = path;
  const auth = enableAuth ? new UserAuthService(path, "Администратор", "test-admin-password") : undefined;
  const server = createAggregatorServer({ application: { streamSearch: async () => {}, listSupplierSessions: () => [] }, publicDir: resolve("src/frontend"), auth });
  try {
    await new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolvePromise); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const request = (url, options) => fetch(origin + url, options);
    await check({ request, path, server });
  } finally {
    server.closeAllConnections();
    await new Promise((resolvePromise) => server.close(resolvePromise));
    if (previousPath === undefined) delete process.env.GARAGE_DB_PATH; else process.env.GARAGE_DB_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
}

async function key(request, source, cookie) {
  const response = await request(`/api/nomenclature/connections/${source}`, { method: "POST", ...json({}, cookie ? { Cookie: cookie } : {}) });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.match(data.token, /^[A-Za-z0-9_-]{43}$/);
  return data.token;
}
const poll = (request, source, token, waitSeconds = 0) => request(`/api/integration/1c/nomenclature/${source}/requests?waitSeconds=${waitSeconds}`, { headers: { Authorization: `Bearer ${token}` } });
const completion = (job, products = [product]) => ({ requestId: job.id, leaseId: job.leaseId, status: products.length ? "found" : "not_found", products });
const sendResult = (request, source, token, data) => request(`/api/integration/1c/nomenclature/${source}/results`, { method: "POST", ...json(data, { Authorization: `Bearer ${token}` }) });

test("nomenclature HTTP isolates sources, hashes keys and exchanges one requested product without a catalogue export", async () => {
  await withServer(async ({ request, path }) => {
    let sources = await (await request("/api/nomenclature/sources")).json();
    assert.equal(sources.defaultSource, "production");
    assert.equal(sources.sources.every((source) => !source.configured && !source.online), true);
    const unavailable = await request("/api/nomenclature/lookups", { method: "POST", ...json({ sourceId: "test", barcode: "0000123" }) });
    assert.equal(unavailable.status, 503);
    const testToken = await key(request, "test");
    const productionToken = await key(request, "production");
    const stillOffline = await request("/api/nomenclature/lookups", { method: "POST", ...json({ sourceId: "test", barcode: "0000123" }) });
    assert.equal(stillOffline.status, 503);
    const status = await request("/api/integration/1c/nomenclature/test/status", { headers: { Authorization: `Bearer ${testToken}` } });
    assert.deepEqual(await status.json(), { ready: true, sourceId: "test" });
    assert.equal((await poll(request, "test", productionToken)).status, 401);
    assert.equal((await poll(request, "production", testToken)).status, 401);
    assert.deepEqual(await (await poll(request, "test", testToken)).json(), { request: null });
    await poll(request, "production", productionToken);
    const created = await request("/api/nomenclature/lookups", { method: "POST", ...json({ sourceId: "test", barcode: "0000123" }) });
    assert.equal(created.status, 202);
    const lookup = (await created.json()).lookup;
    assert.equal(lookup.barcode, "0000123");
    assert.equal(lookup.status, "pending");
    assert.equal(created.headers.get("cache-control"), "no-store");
    assert.deepEqual(await (await poll(request, "production", productionToken)).json(), { request: null });
    const job = (await (await poll(request, "test", testToken)).json()).request;
    assert.equal(job.id, lookup.id);
    assert.equal(job.barcode, "0000123");
    assert.deepEqual(await (await poll(request, "test", testToken)).json(), { request: null });
    const data = completion(job);
    const accepted = await sendResult(request, "test", testToken, data);
    assert.equal(accepted.status, 200);
    assert.equal((await sendResult(request, "test", testToken, data)).status, 200);
    assert.equal((await sendResult(request, "production", productionToken, data)).status, 409);
    const different = { ...data, products: [{ ...product, name: "Другой ответ" }] };
    assert.equal((await sendResult(request, "test", testToken, different)).status, 409);
    const card = await (await request(`/api/nomenclature/lookups/${lookup.id}`)).json();
    assert.equal(card.lookup.status, "found");
    assert.deepEqual(card.lookup.products, [product]);
    sources = await (await request("/api/nomenclature/sources")).json();
    const publicState = JSON.stringify(sources);
    assert.equal(publicState.includes(testToken), false);
    assert.equal(publicState.includes("token_hash"), false);
    const database = new DatabaseSync(path);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM nomenclature_lookups").get().count, 1);
    assert.notEqual(database.prepare("SELECT token_hash FROM nomenclature_sources WHERE id='test'").get().token_hash, testToken);
    database.close();
    assert.equal((await readFile(path)).includes(Buffer.from(testToken)), false);
  });
});

test("long polling wakes for new work and revoked keys cannot claim future work", async () => {
  await withServer(async ({ request }) => {
    const token = await key(request, "test");
    const waiting = poll(request, "test", token, 20);
    for (let count = 0; count < 100; count += 1) {
      const state = await (await request("/api/nomenclature/sources")).json();
      if (state.sources.find((source) => source.id === "test").online) break;
    }
    const response = await request("/api/nomenclature/lookups", { method: "POST", ...json({ sourceId: "test", barcode: "2000043626425" }) });
    assert.equal(response.status, 202);
    const job = (await (await waiting).json()).request;
    assert.equal(job.barcode, "2000043626425");
    const revokedWait = poll(request, "test", token, 20);
    // A status read provides an event-loop turn for the worker request to register.
    await request("/api/nomenclature/sources");
    const replacement = await key(request, "test");
    assert.notEqual(replacement, token);
    assert.equal((await revokedWait).status, 401);
    assert.equal((await sendResult(request, "test", token, completion(job))).status, 401);
    assert.equal((await (await request(`/api/nomenclature/lookups/${job.id}`)).json()).lookup.status, "error");
  });
});

test("lookup state persists, ownership is enforced, leases are reclaimed and late answers are rejected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aggregator-nomenclature-state-"));
  const path = join(directory, "database.sqlite");
  let now = Date.now();
  let service = new NomenclatureService(path, () => now);
  try {
    const token = service.rotateKey("test");
    service.setDefault("test");
    service.heartbeat("test", token);
    const lookup = service.create("test", "0000001", "first-user");
    assert.throws(() => service.get(lookup.id, "second-user", false), (error) => error.statusCode === 404);
    const first = service.claim("test", token);
    service.close();
    service = new NomenclatureService(path, () => now);
    assert.equal(service.state().defaultSource, "test");
    service.authenticate("test", token);
    assert.equal(service.claim("test", token), null);
    now += 10_001;
    const next = service.claim("test", token);
    assert.equal(next.id, first.id);
    assert.notEqual(next.leaseId, first.leaseId);
    assert.throws(() => service.complete("test", token, completion(first)), (error) => error.code === "lease_mismatch");
    service.complete("test", token, completion(next, []));
    assert.equal(service.get(lookup.id, "first-user", false).status, "not_found");
    const expires = service.create("test", "0000002", "first-user");
    const expiredJob = service.claim("test", token);
    now += 30_001;
    assert.equal(service.get(expires.id, "first-user", false).status, "expired");
    assert.throws(() => service.complete("test", token, completion(expiredJob)), (error) => error.statusCode === 409);
    now += 45_001;
    assert.throws(() => service.create("test", "0000003", "first-user"), (error) => error.code === "source_offline");
    service.heartbeat("test", token);
    for (let i = 0; i < 3; i += 1) service.create("test", `code-${i}`, "first-user");
    assert.throws(() => service.create("test", "code-4", "first-user"), (error) => error.statusCode === 429);
    service.disconnect("test");
    assert.equal(service.state().sources.find((source) => source.id === "test").online, false);
    assert.throws(() => service.authenticate("test", token), (error) => error.statusCode === 401);
  } finally { service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("nomenclature routes enforce form access, administrator settings and request ownership", async () => {
  await withServer(async ({ request, path }) => {
    assert.equal((await request("/api/nomenclature/sources")).status, 401);
    const adminLogin = await request("/api/auth/login", { method: "POST", ...json({ fio: "Администратор", password: "test-admin-password" }) });
    const adminCookie = adminLogin.headers.get("set-cookie").split(";", 1)[0];
    // Simulates an administrator created before the new nomenclature permission existed.
    const database = new DatabaseSync(path);
    database.prepare("UPDATE aggregator_users SET permissions='[\"markup\"]' WHERE is_admin=1").run();
    database.close();
    assert.equal((await request("/api/nomenclature/sources", { headers: { Cookie: adminCookie } })).status, 200);
    for (const [fio, permissions] of [["Номенклатура один", ["nomenclature"]], ["Номенклатура два", ["nomenclature"]], ["Без доступа", ["markup"]]]) {
      const created = await request("/api/users", { method: "POST", ...json({ fio, permissions, password: "test-user-password" }, { Cookie: adminCookie }) });
      assert.equal(created.status, 201);
    }
    const login = async (fio) => (await request("/api/auth/login", { method: "POST", ...json({ fio, password: "test-user-password" }) })).headers.get("set-cookie").split(";", 1)[0];
    const first = await login("Номенклатура один");
    const second = await login("Номенклатура два");
    const denied = await login("Без доступа");
    assert.equal((await request("/api/nomenclature/sources", { headers: { Cookie: denied } })).status, 403);
    assert.equal((await request("/api/nomenclature/settings", { headers: { Cookie: first } })).status, 403);
    const token = await key(request, "test", adminCookie);
    await poll(request, "test", token);
    const lookup = (await (await request("/api/nomenclature/lookups", { method: "POST", ...json({ sourceId: "test", barcode: "2000043626425" }, { Cookie: first }) })).json()).lookup;
    assert.equal((await request(`/api/nomenclature/lookups/${lookup.id}`, { headers: { Cookie: second } })).status, 404);
    assert.equal((await request(`/api/nomenclature/lookups/${lookup.id}`, { method: "DELETE", headers: { Cookie: second } })).status, 404);
    assert.equal((await request(`/api/nomenclature/lookups/${lookup.id}`, { headers: { Cookie: adminCookie } })).status, 200);
    assert.equal((await request(`/api/nomenclature/lookups/${lookup.id}`, { method: "DELETE", headers: { Cookie: first } })).status, 200);
    assert.equal((await (await poll(request, "test", token)).json()).request, null);
  }, true);
});

test("nomenclature validates payloads, matching characteristics and zero or missing prices", async () => {
  const id = "12345678-abcd-1234-abcd-123456789abc";
  const valid = { requestId: id, leaseId: id, status: "found", products: [product] };
  assert.deepEqual(parseLookupResult(valid).products[0].prices, product.prices);
  for (const data of [
    { ...valid, extra: true }, { ...valid, products: [] }, { ...valid, status: "not_found" },
    { ...valid, status: ["error"], products: [] },
    { ...valid, products: [product, product] },
    { ...valid, products: [{ ...product, characteristicId: id }] },
    { ...valid, products: [{ ...product, prices: { ...product.prices, purchase: { amount: -1, currency: "RUB" } } }] },
  ]) assert.throws(() => parseLookupResult(data));
  await withServer(async ({ request }) => {
    assert.equal((await request("/api/nomenclature/lookups", { method: "POST", ...json({ sourceId: "test", barcode: "code\nvalue" }) })).status, 400);
    assert.equal((await request("/api/nomenclature/settings?secret=bad")).status, 400);
    assert.equal((await request("/api/nomenclature/lookups", { method: "POST", body: "not-json" })).status, 415);
    const token = await key(request, "test");
    assert.equal((await poll(request, "test", token, 21)).status, 400);
    assert.equal((await request("/api/integration/1c/nomenclature/test/status")).status, 401);
  });
});
