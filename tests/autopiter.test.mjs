import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AutopiterApiAdapter, verifyAutopiterCredentials } from "../src/backend/suppliers/autopiter/autopiter-api-adapter.ts";
import { SupplierSessionManager } from "../src/backend/session/session-manager.ts";
import { SupplierSessionService } from "../src/backend/application/supplier-session-service.ts";
import { SearchApplicationService } from "../src/backend/application/search-application-service.ts";
import { createAggregatorServer } from "../src/backend/http/create-server.ts";
import { EncryptedSupplierCredentialStore } from "../src/backend/session/encrypted-credential-store.ts";
import { SupplierAuthError, SupplierIntegrationError, SupplierTimeoutError } from "../src/backend/errors.ts";
import { runSupplierSearch } from "../src/backend/suppliers/run-supplier-search.ts";
import { getPurchaseReference } from "../src/backend/purchasing/purchase-offer.ts";
import { isAutopiterReturnableVisible } from "../src/frontend/autopiter-return-settings.js";

// Fictional SOAP fixtures; no requests to real suppliers.
const credentials = { login: "123456", password: " test-password " };
const cookie = "AuthCoocies=fixture-cookie";
const signal = () => new AbortController().signal;
const context = () => ({ signal: signal(), timeoutMs: 1000 });
const response = (method, content, extra = {}) => ({ status: 200, contentType: "text/xml; charset=utf-8", setCookie: [],
  body: `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><${method}Response xmlns="http://www.autopiter.ru/"><${method}Result>${content}</${method}Result></${method}Response></s:Body></s:Envelope>`, ...extra });
// WSDL declares both list Result elements optional (minOccurs=0).
const emptyResponse = (method) => response(method, "", {
  body: `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${method}Response xmlns="http://www.autopiter.ru/" /></soap:Body></soap:Envelope>`,
});
const fields = (data) => Object.entries(data).map(([key, value]) => `<${key}>${value ?? ""}</${key}>`).join("");
const catalog = (data = {}) => `<SearchCatalogModel>${fields({ ArticleId: "101", CatalogName: "TEST", Number: "A-1", ...data })}</SearchCatalogModel>`;
const offer = (data = {}) => `<PriceSearchModel>${fields({ Number: "A-1", CatalogName: "TEST", Name: "Тестовый фильтр &amp; комплект", SalePrice: "125.50", NumberOfAvailable: "7", Region: "Тестовый склад", DeliveryDate: "2026-11-10T00:00:00+03:00", TypeRefusal: "1", CurrencyName: "RUB", ...data })}</PriceSearchModel>`;
function manager() { const value = new SupplierSessionManager(); value.setAutopiterCredentials(credentials, cookie); value.markAuthorized("autopiter"); return value; }
async function searchOffers(content) {
  const adapter = new AutopiterApiAdapter(async (method) => method === "FindCatalog" ? response(method, catalog()) : response(method, content));
  const results = [];
  await adapter.search({ article: "A1" }, context(), (result) => results.push(result), manager());
  return results;
}

test("Autopiter authorizes with client number, preserves all applicable cookies and confirms the session", async () => {
  const received = [];
  assert.equal(await verifyAutopiterCredentials(credentials, signal(), async (...args) => {
    received.push(args);
    return args[0] === "Authorization" ? response("Authorization", "true", { setCookie: ["ASP.NET_SessionId=fixture-session; Path=/; HttpOnly", `${cookie}; HttpOnly; Secure; Path=/`] })
      : response("IsAuthorization", "true");
  }), `ASP.NET_SessionId=fixture-session; ${cookie}`);
  assert.equal(received[0][0], "Authorization");
  assert.deepEqual(received[0][1], { UserID: "123456", Password: " test-password ", Save: "false" });
  assert.equal(received.length, 2);
  assert.equal(received[1][0], "IsAuthorization");
  assert.equal(received[1][3], `ASP.NET_SessionId=fixture-session; ${cookie}`);
  for (const [payload, type] of [[response("Authorization", "false"), SupplierAuthError],
    [response("Authorization", "true"), SupplierIntegrationError], [response("Authorization", "maybe"), SupplierIntegrationError],
    [response("Authorization", "true", { status: 401 }), SupplierAuthError]]) {
    await assert.rejects(verifyAutopiterCredentials(credentials, signal(), async () => payload), type);
  }
});

test("Autopiter validates sessions without product searches and never invents access", async () => {
  const calls = [];
  const adapter = new AutopiterApiAdapter(async (...args) => { calls.push(args); return response("IsAuthorization", "true"); });
  assert.equal((await adapter.ensureSession(new SupplierSessionManager())).authorized, false);
  await assert.rejects(adapter.validateSession(context(), new SupplierSessionManager()), SupplierAuthError);
  await adapter.validateSession(context(), manager());
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "IsAuthorization");
  assert.equal(calls[0][3], cookie);
  await assert.rejects(new AutopiterApiAdapter(async () => response("IsAuthorization", "false")).validateSession(context(), manager()), SupplierAuthError);
});

test("Autopiter rejects a new login when the separate session check fails", async () => {
  const methods = [];
  await assert.rejects(verifyAutopiterCredentials(credentials, signal(), async (method) => {
    methods.push(method);
    return method === "Authorization" ? response(method, "true", { setCookie: [cookie] }) : response(method, "false");
  }), SupplierAuthError);
  assert.deepEqual(methods, ["Authorization", "IsAuthorization"]);
});

test("Autopiter retains session cookies from login through validation and pricing, and recovers after restart or expiry", async () => {
  let authorizations = 0;
  let expectedCookie;
  let validations = 0;
  const request = async (method, _fields, receivedSignal, receivedCookie) => {
    receivedSignal.throwIfAborted();
    if (method === "Authorization") {
      authorizations++;
      expectedCookie = `AuthCoocies=fixture-${authorizations}; ASP.NET_SessionId=session-${authorizations}; affinity=node-a`;
      return response(method, "true", { setCookie: [`AuthCoocies=fixture-${authorizations}; Path=/; HttpOnly; Secure`,
        `ASP.NET_SessionId=session-${authorizations}; Path=/; HttpOnly`, "affinity=node-a; Path=/; Secure"] });
    }
    if (method === "IsAuthorization") {
      validations++;
      return response(method, receivedCookie === expectedCookie ? "true" : "false");
    }
    if (receivedCookie !== expectedCookie) return response(method, "", { status: 401 });
    if (method === "FindCatalog") {
      expectedCookie = `AuthCoocies=fixture-${authorizations}; ASP.NET_SessionId=rotated-${authorizations}; affinity=node-a`;
      return response(method, catalog(), { setCookie: [`ASP.NET_SessionId=rotated-${authorizations}; Path=/; HttpOnly`] });
    }
    assert.equal(method, "GetPriceId");
    return response(method, offer());
  };
  const adapter = new AutopiterApiAdapter(request);
  const sessions = new SupplierSessionManager();
  const service = new SupplierSessionService([adapter], sessions, {
    verifyAutopiterCredentials: (data, authSignal) => verifyAutopiterCredentials(data, authSignal, request),
  });
  await service.authorizeAutopiter(credentials, signal());
  const results = [];
  await adapter.search({ article: "A1" }, context(), (value) => results.push(value), sessions);
  assert.equal(results.length, 1);
  assert.equal(authorizations, 1);
  assert.equal(sessions.getAutopiterCookie(), expectedCookie);
  const restarted = new SupplierSessionManager();
  restarted.setAutopiterCredentials(credentials); restarted.markAuthorized("autopiter");
  // The frontend opens SSE directly; it does not call the session-validation endpoint first.
  const events = [];
  await runSupplierSearch({ adapter, sessionManager: restarted, query: { article: "A1" }, signal: signal(), emit: (event) => events.push(event) });
  assert.equal(events.at(-1).status, "completed");
  assert.equal(events.filter((event) => event.type === "result").length, 1);
  assert.equal(authorizations, 2);
  expectedCookie = "expired-on-server";
  await adapter.search({ article: "A1" }, context(), (value) => results.push(value), restarted);
  assert.equal(authorizations, 3);
  assert.equal(results.length, 2);
  assert.equal(validations, 3);
});

test("Autopiter merges refreshed cookies, discards expired cookies and never forwards foreign cookie scopes", async () => {
  const incoming = [];
  const verified = await verifyAutopiterCredentials(credentials, signal(), async (method, _fields, _signal, receivedCookie) => {
    incoming.push(receivedCookie);
    return method === "Authorization" ? response(method, "true", { setCookie: [cookie,
      "ASP.NET_SessionId=first; Domain=.autopiter.ru; Path=/v2", "affinity=node-a; Path=/",
      "otherOrigin=secret; Domain=another.test; Path=/", "otherPath=secret; Path=/other",
      "expired=discard; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/"] })
      : response(method, "true", { setCookie: ["ASP.NET_SessionId=second; Path=/", "affinity=; Max-Age=0; Path=/"] });
  });
  assert.equal(incoming[1], `${cookie}; ASP.NET_SessionId=first; affinity=node-a`);
  assert.equal(verified, `${cookie}; ASP.NET_SessionId=second`);
});

test("Autopiter performs at most one full recovery and never retries timeouts or integration failures", async () => {
  for (const failure of [new SupplierAuthError(), new SupplierTimeoutError(), new SupplierIntegrationError()]) {
    let authorizations = 0;
    let searches = 0;
    const adapter = new AutopiterApiAdapter(async (method) => {
      if (method === "Authorization") { authorizations++; return response(method, "true", { setCookie: [cookie] }); }
      if (method === "IsAuthorization") return response(method, "true");
      searches++; throw failure;
    });
    await assert.rejects(adapter.search({ article: "A1" }, context(), () => assert.fail("unexpected result"), manager()), failure.constructor);
    assert.equal(authorizations, failure instanceof SupplierAuthError ? 1 : 0);
    assert.equal(searches, failure instanceof SupplierAuthError ? 2 : 1);
  }
});

test("Autopiter logout prevents late search recovery and rotated cookies from restoring the session", async () => {
  for (const missingCookie of [false, true]) {
    const sessions = manager();
    if (missingCookie) sessions.setAutopiterCredentials(credentials);
    let release;
    const adapter = new AutopiterApiAdapter((method) => new Promise((resolve) => {
      release = () => resolve(method === "Authorization" ? response(method, "true", { setCookie: [cookie] })
        : response(method, catalog(), { setCookie: ["ASP.NET_SessionId=late; Path=/"] }));
    }));
    const service = new SupplierSessionService([adapter], sessions, {});
    const pending = adapter.search({ article: "A1" }, context(), () => assert.fail("unexpected result"), sessions);
    const rejected = assert.rejects(pending, /invalidated/i);
    service.logoutAutopiter(); release(); await rejected;
    assert.equal(sessions.getAutopiterCookie(), null);
    assert.equal(sessions.getAutopiterCredentials(), null);
    assert.equal(sessions.getSession("autopiter").authorized, false);
  }
});

test("Autopiter shares its one recovery attempt across catalog and price requests", async () => {
  let authorizations = 0;
  let priceCalls = 0;
  const results = [];
  const attempts = new Map();
  const adapter = new AutopiterApiAdapter(async (method, parameters) => {
    if (method === "FindCatalog") return response(method, catalog() + catalog({ ArticleId: "102" }));
    if (method === "Authorization") { authorizations++; return response(method, "true", { setCookie: [cookie] }); }
    if (method === "IsAuthorization") return response(method, "true");
    priceCalls++;
    const attempt = (attempts.get(parameters.ArticleId) ?? 0) + 1;
    attempts.set(parameters.ArticleId, attempt);
    return parameters.ArticleId === "101" && attempt === 2 ? response(method, offer()) : response(method, "", { status: 401 });
  });
  await assert.rejects(adapter.search({ article: "A1" }, context(), (value) => results.push(value), manager()), SupplierAuthError);
  assert.equal(authorizations, 1);
  assert.equal(priceCalls, 4);
  assert.equal(results.length, 1);
});

test("Autopiter prices every exact catalog once, filters other articles and replacements and does not enable orders", async () => {
  const calls = [];
  const adapter = new AutopiterApiAdapter(async (method, params, _signal, receivedCookie) => {
    calls.push({ method, params, receivedCookie });
    return method === "FindCatalog" ? response(method, catalog() + catalog() + catalog({ ArticleId: "102", CatalogName: "OTHER" }) + catalog({ ArticleId: "103", Number: "B1" }))
      : response(method, offer() + offer({ Number: "B1" }) + offer({ NumberChange: "C1" }));
  });
  const results = [];
  await adapter.search({ article: "A1" }, context(), (value) => results.push(value), manager());
  assert.deepEqual(calls.map((call) => call.method), ["FindCatalog", "GetPriceId", "GetPriceId"]);
  assert.deepEqual(calls.slice(1).map((call) => call.params.ArticleId), ["101", "102"]);
  assert.ok(calls.every((call) => call.receivedCookie === cookie));
  assert.ok(calls.slice(1).every((call) => call.params.SearchCross === "0" && call.params.Currency === "РУБ"));
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], { supplier: "autopiter", article: "A-1", brand: "TEST", title: "Тестовый фильтр & комплект", price: 125.5,
    quantity: 7, warehouse: "Тестовый склад", deliveryDate: "2026-11-10T00:00:00.000Z", deliveryDateApproximate: false, isReturnable: true, link: "https://autopiter.ru/" });
  assert.equal(getPurchaseReference(results[0]), null);
  assert.equal(typeof adapter.searchAnalogs, "function");
});

test("Autopiter analogs use selected-brand catalogs and preserve distinct offers without originals or duplicates", async () => {
  const calls = [];
  const cross = { Number: "B-1", CatalogName: "CROSS", DetailUid: "cross-1", SellerId: "10" };
  const adapter = new AutopiterApiAdapter(async (method, parameters) => {
    calls.push({ method, parameters });
    if (method === "FindCatalog") return response(method, catalog({ CatalogName: "TEST.CO" })
      + catalog({ ArticleId: "102", CatalogName: "OTHER" }) + catalog({ ArticleId: "103", CatalogName: "Test-Co" })
      + catalog({ ArticleId: "104", Number: "UNRELATED", CatalogName: "TEST.CO" }));
    return response(method, offer({ CatalogName: "TEST.CO" }) + offer(cross) + offer(cross)
      + offer({ Number: "A1", CatalogName: "OTHER", DetailUid: "same-number-cross" })
      + offer({ ...cross, Region: "Другой склад" }) + offer({ ...cross, SalePrice: "200" })
      + offer({ ...cross, TypeRefusal: "3" }) + offer({ ...cross, SellerId: "11" })
      + offer({ ...cross, DetailUid: "different-offer" }) + offer({ ...cross, NumberChange: "C1" }));
  });
  const results = [];
  await adapter.searchAnalogs({ mode: "analogs", article: "A1", brand: " test co " }, context(), (value) => results.push(value), manager());
  assert.deepEqual(calls.map((call) => call.method), ["FindCatalog", "GetPriceId", "GetPriceId"]);
  assert.deepEqual(calls.slice(1).map((call) => call.parameters.ArticleId), ["101", "103"]);
  assert.ok(calls.slice(1).every((call) => call.parameters.SearchCross === "1" && call.parameters.Currency === "РУБ"));
  assert.equal(results.length, 7);
  assert.ok(results.every((result) => result.isAnalog === true && getPurchaseReference(result) === null));
  assert.equal(results.filter((result) => result.brand === "OTHER" && result.article === "A1").length, 1);
  assert.ok(results.some((result) => result.price === 200));
  assert.ok(results.some((result) => result.warehouse === "Другой склад"));
  assert.equal(results.filter((result) => !result.isReturnable).length, 1);
  const before = calls.length;
  await adapter.searchAnalogs({ mode: "analogs", article: "A1", brand: "NO MATCH" }, context(), () => assert.fail("wrong-brand analog"), manager());
  assert.deepEqual(calls.slice(before).map((call) => call.method), ["FindCatalog"]);
});

test("Autopiter discovery and analogs participate in the shared search lifecycle", async () => {
  const calls = [];
  const adapter = new AutopiterApiAdapter(async (method, parameters) => {
    calls.push({ method, parameters });
    return method === "FindCatalog"
      ? response(method, catalog() + catalog({ ArticleId: "102", CatalogName: "test" })
        + catalog({ ArticleId: "103", CatalogName: "OTHER" }) + catalog({ ArticleId: "104", Number: "UNRELATED", CatalogName: "SKIP" }))
      : response(method, offer({ Number: "B1", CatalogName: "CROSS" }));
  });
  const service = new SearchApplicationService([adapter], manager(), () => assert.fail("unexpected disconnection"));
  const events = [];
  await service.streamSearch({ mode: "brands", article: "A1", suppliers: ["autopiter"] }, (event) => events.push(event), signal());
  assert.deepEqual(events[0].suppliers, ["autopiter"]);
  assert.deepEqual(events.find((event) => event.type === "brand_candidates"), { type: "brand_candidates", supplier: "autopiter", brands: ["TEST", "OTHER"] });
  assert.deepEqual(calls.map((call) => call.method), ["FindCatalog"]);
  events.length = 0;
  await service.streamSearch({ mode: "analogs", article: "A1", brand: "TEST", suppliers: ["autopiter"] }, (event) => events.push(event), signal());
  assert.deepEqual(events[0].suppliers, ["autopiter"]);
  assert.equal(events.filter((event) => event.type === "result").length, 1);
  assert.equal(events.find((event) => event.type === "result").result.isAnalog, true);
  assert.equal(events.at(-2).status, "completed");
  assert.equal(events.at(-1).type, "search_completed");
});

test("Autopiter analog and brand searches recover expired sessions and accept optional empty results", async () => {
  for (const mode of ["brands", "analogs"]) {
    let authorizations = 0;
    const sessions = new SupplierSessionManager();
    sessions.setAutopiterCredentials(credentials);
    sessions.markAuthorized("autopiter");
    const adapter = new AutopiterApiAdapter(async (method, parameters, _signal, receivedCookie) => {
      if (method === "Authorization") { authorizations++; return response(method, "true", { setCookie: [cookie] }); }
      assert.equal(receivedCookie, cookie);
      if (method === "IsAuthorization") return response(method, "true");
      if (method === "FindCatalog") return response(method, catalog());
      assert.equal(parameters.SearchCross, "1");
      return emptyResponse(method);
    });
    const events = [];
    await runSupplierSearch({ adapter, sessionManager: sessions, query: { mode, article: "A1", ...(mode === "analogs" ? { brand: "TEST" } : {}) },
      signal: signal(), emit: (event) => events.push(event) });
    assert.equal(authorizations, 1);
    assert.equal(events.at(-1).status, "completed");
    assert.equal(events.filter((event) => event.type === "result").length, 0);
    const empty = new AutopiterApiAdapter(async (method) => emptyResponse(method));
    const values = [];
    await empty[mode === "brands" ? "searchBrands" : "searchAnalogs"]({ mode, article: "A1", brand: "TEST" }, context(), (value) => values.push(value), manager());
    assert.deepEqual(values, mode === "brands" ? [[]] : []);
  }
});

test("Autopiter brand and analog HTTP streams include real adapter results in the shared API", async () => {
  const directory = mkdtempSync(join(tmpdir(), "autopiter-search-http-"));
  const previousPath = process.env.GARAGE_DB_PATH;
  process.env.GARAGE_DB_PATH = join(directory, "garage.sqlite");
  const requests = [];
  const adapter = new AutopiterApiAdapter(async (method, parameters) => {
    requests.push({ method, parameters });
    return response(method, method === "FindCatalog" ? catalog() : offer({ Number: "B1", CatalogName: "CROSS" }));
  });
  const service = new SearchApplicationService([adapter], manager(), () => assert.fail("unexpected disconnection"));
  const server = createAggregatorServer({ application: { streamSearch: service.streamSearch.bind(service) }, publicDir: resolve("src/frontend") });
  try {
    await new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolvePromise); });
    for (const mode of ["brands", "analogs"]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/search?stream=once&article=A1&supplier=autopiter&mode=${mode}&brand=TEST`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /text\/event-stream/);
      const events = (await response.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
      assert.deepEqual(events[0].suppliers, ["autopiter"]);
      assert.equal(events.at(-1).type, "search_completed");
      if (mode === "brands") {
        assert.deepEqual(events.find((event) => event.type === "brand_candidates").brands, ["TEST"]);
      } else {
        const offer = events.find((event) => event.type === "result");
        assert.equal(offer.result.article, "B1");
        assert.equal(offer.result.isAnalog, true);
        assert.equal(typeof offer.offerId, "string");
      }
    }
    assert.deepEqual(requests.map((request) => request.method), ["FindCatalog", "FindCatalog", "GetPriceId"]);
    assert.equal(requests.at(-1).parameters.SearchCross, "1");
  } finally {
    server.closeAllConnections();
    await new Promise((resolvePromise) => server.close(resolvePromise));
    if (previousPath === undefined) delete process.env.GARAGE_DB_PATH;
    else process.env.GARAGE_DB_PATH = previousPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Autopiter analog search aborts all pending catalog prices without late offers", { timeout: 3000 }, async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers();
  let active = 0;
  let requests = 0;
  const adapter = new AutopiterApiAdapter(async (method, parameters, requestSignal) => {
    if (method === "FindCatalog") return response(method, Array.from({ length: 8 }, (_, index) => catalog({ ArticleId: String(101 + index) })).join(""));
    assert.equal(parameters.SearchCross, "1");
    requests++;
    active++;
    if (active === 4) started.resolve();
    try {
      return await new Promise((_resolve, reject) => requestSignal.addEventListener("abort", () => reject(requestSignal.reason), { once: true }));
    } finally { active--; }
  });
  const pending = adapter.searchAnalogs({ mode: "analogs", article: "A1", brand: "TEST" }, { signal: controller.signal, timeoutMs: 1000 }, () => assert.fail("late offer"), manager());
  const rejected = assert.rejects(pending, /cancelled/);
  await started.promise;
  controller.abort(new Error("cancelled"));
  await rejected;
  assert.equal(active, 0);
  assert.equal(requests, 4);
});

test("Autopiter overlaps catalog prices with bounded concurrency and preserves offer order", async (t) => {
  const ids = Array.from({ length: 12 }, (_, index) => String(101 + index));
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const adapter = new AutopiterApiAdapter(async (method, parameters, requestSignal) => {
    if (method === "FindCatalog") return response(method, ids.map((ArticleId) => catalog({ ArticleId })).join(""));
    assert.equal(method, "GetPriceId");
    calls++; active++; maximumActive = Math.max(maximumActive, active);
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { requestSignal.removeEventListener("abort", abort); resolve(); }, parameters.ArticleId === "101" ? 80 : 40);
        const abort = () => { clearTimeout(timeout); reject(requestSignal.reason); };
        requestSignal.addEventListener("abort", abort, { once: true });
      });
      return response(method, offer({ Region: `Тестовый склад ${parameters.ArticleId}`, TypeRefusal: Number(parameters.ArticleId) % 2 ? "3" : "1" }));
    } finally { active--; }
  });
  const results = [];
  const started = performance.now();
  await adapter.search({ article: "A1" }, context(), (value) => results.push(value), manager());
  t.diagnostic(`12 catalog price requests: ${Math.round(performance.now() - started)} ms; peak concurrent requests: ${maximumActive}`);
  assert.equal(maximumActive, 4);
  assert.equal(active, 0);
  assert.equal(calls, ids.length);
  assert.deepEqual(results.map((value) => value.warehouse), ids.map((id) => `Тестовый склад ${id}`));
  assert.deepEqual(results.map((value) => value.isReturnable), ids.map((id) => Number(id) % 2 === 0));
});

test("Autopiter shares one pending authorization between concurrently expired requests", async () => {
  let authorizations = 0;
  const attempts = new Map();
  const freshCookie = "AuthCoocies=renewed-fixture";
  const ids = Array.from({ length: 6 }, (_, index) => String(101 + index));
  const adapter = new AutopiterApiAdapter(async (method, parameters, requestSignal, receivedCookie) => {
    requestSignal.throwIfAborted();
    if (method === "FindCatalog") return response(method, ids.map((ArticleId) => catalog({ ArticleId })).join(""));
    if (method === "Authorization") {
      authorizations++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return response(method, "true", { setCookie: [freshCookie] });
    }
    if (method === "IsAuthorization") return response(method, receivedCookie === freshCookie ? "true" : "false");
    attempts.set(parameters.ArticleId, (attempts.get(parameters.ArticleId) ?? 0) + 1);
    return receivedCookie === freshCookie ? response(method, offer({ Region: `Тестовый склад ${parameters.ArticleId}` })) : response(method, "", { status: 401 });
  });
  const sessions = manager();
  const results = [];
  await adapter.search({ article: "A1" }, context(), (value) => results.push(value), sessions);
  assert.equal(authorizations, 1);
  assert.equal(sessions.getAutopiterCookie(), freshCookie);
  assert.deepEqual([...attempts.values()], [2, 2, 2, 2, 1, 1]);
  assert.deepEqual(results.map((value) => value.warehouse), ids.map((id) => `Тестовый склад ${id}`));
});

test("Autopiter cancels all prefetched prices and never starts queued catalogs after cancellation or logout", { timeout: 3000 }, async () => {
  for (const reason of [new Error("client cancelled"), new SupplierTimeoutError(), "logout"]) {
    const sessions = manager();
    const controller = new AbortController();
    const started = Promise.withResolvers();
    let active = 0;
    let requests = 0;
    let cancelled = 0;
    const adapter = new AutopiterApiAdapter(async (method, _fields, requestSignal) => {
      requestSignal.throwIfAborted();
      if (method === "FindCatalog") return response(method, Array.from({ length: 8 }, (_, index) => catalog({ ArticleId: String(101 + index) })).join(""));
      active++; requests++;
      if (active === 4) started.resolve();
      try {
        return await new Promise((_resolve, reject) => requestSignal.addEventListener("abort", () => {
          cancelled++; reject(requestSignal.reason);
        }, { once: true }));
      } finally { active--; }
    });
    const pending = adapter.search({ article: "A1" }, { signal: controller.signal, timeoutMs: 1000 }, () => assert.fail("late result"), sessions);
    const rejected = assert.rejects(pending, reason === "logout" ? /invalidated/i : (error) => error === reason);
    await started.promise;
    if (reason === "logout") new SupplierSessionService([adapter], sessions, {}).logoutAutopiter();
    else controller.abort(reason);
    await rejected;
    assert.equal(active, 0);
    assert.equal(requests, 4);
    assert.equal(cancelled, 4);
    if (reason === "logout") assert.equal(sessions.getAutopiterCookie(), null);
  }
});

test("Autopiter reports a failed catalog and closes outstanding price requests", async () => {
  const failure = new SupplierIntegrationError("fictional upstream failure");
  let requests = 0;
  let active = 0;
  let cancelled = 0;
  const adapter = new AutopiterApiAdapter(async (method, parameters, requestSignal) => {
    if (method === "FindCatalog") return response(method, Array.from({ length: 8 }, (_, index) => catalog({ ArticleId: String(101 + index) })).join(""));
    requests++;
    if (parameters.ArticleId === "101") throw failure;
    active++;
    try {
      return await new Promise((_resolve, reject) => requestSignal.addEventListener("abort", () => {
        cancelled++; reject(requestSignal.reason);
      }, { once: true }));
    } finally { active--; }
  });
  await assert.rejects(adapter.search({ article: "A1" }, context(), () => assert.fail("unexpected result"), manager()), (error) => error === failure);
  assert.equal(requests, 4);
  assert.equal(cancelled, 3);
  assert.equal(active, 0);
});

test("Autopiter hides refusal types 3 and 4 by default, including restored unknown returnability", async () => {
  for (const type of ["0", "1", "2", "3", "4", "03", "5"]) {
    const [result] = await searchOffers(offer({ TypeRefusal: type }));
    assert.equal(result.isReturnable, ![3, 4].includes(Number(type)));
    assert.equal(isAutopiterReturnableVisible(result, false), result.isReturnable);
    assert.equal(isAutopiterReturnableVisible(result, true), true);
  }
  assert.equal(isAutopiterReturnableVisible({ supplier: "autopiter" }, false), false);
  assert.equal(isAutopiterReturnableVisible({ supplier: "armtek", isReturnable: false }, false), true);
});

test("Autopiter preserves unknown quantity and dates, rejects invalid prices, return flags, quantity and currency", async () => {
  for (const value of ["0", ""]) assert.equal((await searchOffers(offer({ NumberOfAvailable: value })))[0].quantity, null);
  for (const value of ["", "invalid", "0001-01-01T00:00:00", "2026-02-30T00:00:00", "2026-11-10T25:00:00"]) {
    assert.equal((await searchOffers(offer({ DeliveryDate: value })))[0].deliveryDate, null);
  }
  for (const data of [{ SalePrice: "Infinity" }, { SalePrice: "0" }, { SalePrice: "-1" }, { CatalogName: "" }, { Name: "" },
    { TypeRefusal: "" }, { TypeRefusal: "NaN" }, { TypeRefusal: "3.5" }, { NumberOfAvailable: "-1" }, { NumberOfAvailable: "1.5" }, { CurrencyName: "USD" }]) {
    await assert.rejects(searchOffers(offer(data)), SupplierIntegrationError);
  }
});

test("Autopiter accepts explicit empty lists but reports SOAP faults, nil and malformed responses", async () => {
  assert.deepEqual(await searchOffers(""), []);
  for (const payload of [response("FindCatalog", "<Unexpected/>"), response("FindCatalog", "<Error>Failure</Error>"),
    response("FindCatalog", "", { contentType: "text/html" }), response("FindCatalog", "", { status: 500 }),
    response("FindCatalog", "", { body: '<!DOCTYPE doc [<!ENTITY x SYSTEM "file:///invalid">]><doc/>' }),
    response("FindCatalog", "", { body: response("FindCatalog", "").body.replace("<FindCatalogResult>", '<FindCatalogResult xsi:nil="true">') }),
    response("FindCatalog", "", { body: '<Envelope><Body><Fault><faultstring>upstream error</faultstring></Fault></Body></Envelope>' })]) {
    const adapter = new AutopiterApiAdapter(async () => payload);
    await assert.rejects(adapter.search({ article: "A1" }, context(), () => assert.fail("unexpected offer"), manager()), SupplierIntegrationError);
  }
  const empty = new AutopiterApiAdapter(async (method) => response(method, ""));
  await empty.search({ article: "A1" }, context(), () => assert.fail("unexpected offer"), manager());
});

test("Autopiter continues other catalogs after the valid 301-byte empty GetPriceId response", async () => {
  assert.equal(Buffer.byteLength(emptyResponse("GetPriceId").body), 301);
  const article = "8450006725";
  const calls = [];
  const adapter = new AutopiterApiAdapter(async (method, parameters) => {
    calls.push(method === "GetPriceId" ? parameters.ArticleId : method);
    if (method === "FindCatalog") return response(method, catalog({ Number: article }) + catalog({ Number: article, ArticleId: "102" }));
    return parameters.ArticleId === "101" ? emptyResponse(method) : response(method, offer({ Number: article }));
  });
  const events = [];
  await runSupplierSearch({ adapter, sessionManager: manager(), query: { article }, signal: signal(), emit: (event) => events.push(event) });
  assert.equal(events.at(-1).status, "completed");
  assert.equal(events.filter((event) => event.type === "result").length, 1);
  assert.deepEqual(calls, ["FindCatalog", "101", "102"]);
});

test("Autopiter accepts omitted optional list results without accepting broken or error envelopes", async () => {
  for (const method of ["FindCatalog", "GetPriceId"]) {
    const adapter = new AutopiterApiAdapter(async (requestedMethod) => requestedMethod === "FindCatalog" && method === "GetPriceId"
      ? response(requestedMethod, catalog()) : emptyResponse(requestedMethod));
    const events = [];
    await runSupplierSearch({ adapter, sessionManager: manager(), query: { article: "A1" }, signal: signal(), emit: (event) => events.push(event) });
    assert.equal(events.at(-1).status, "completed");
    assert.equal(events.filter((event) => event.type === "result").length, 0);
  }
  const empty = emptyResponse("GetPriceId");
  for (const body of [
    empty.body.replace("GetPriceIdResponse", "UnexpectedResponse"),
    empty.body.replace('<GetPriceIdResponse xmlns="http://www.autopiter.ru/" />', ""),
    empty.body.replace(' />', '><Error>Supplier error</Error></GetPriceIdResponse>'),
    empty.body.replace(' />', '>Supplier error</GetPriceIdResponse>'),
    empty.body.replace(' />', ' xsi:nil="true" />'),
    empty.body.replace(' />', '><GetPriceIdResult xsi:nil="true" /></GetPriceIdResponse>'),
    empty.body.replace('</soap:Body>', ''),
  ]) {
    const adapter = new AutopiterApiAdapter(async (method) => method === "FindCatalog" ? response(method, catalog()) : { ...empty, body });
    await assert.rejects(adapter.search({ article: "A1" }, context(), () => assert.fail("unexpected result"), manager()), SupplierIntegrationError);
  }
});

test("Autopiter timeout, cancellation and integration failure keep distinct SSE statuses", async () => {
  for (const [error, status] of [[new SupplierTimeoutError(), "timeout"], [new SupplierIntegrationError("private data"), "error"], [new SupplierAuthError(), "auth_error"]]) {
    const events = [];
    await runSupplierSearch({ adapter: new AutopiterApiAdapter(async () => { throw error; }), sessionManager: manager(), query: { article: "A1" }, signal: signal(), emit: (event) => events.push(event) });
    assert.equal(events.at(-1).status, status);
    assert.doesNotMatch(JSON.stringify(events), /private data/);
  }
  const controller = new AbortController();
  const events = [];
  const adapter = new AutopiterApiAdapter(async (_method, _fields, receivedSignal) => {
    controller.abort(new Error("cancelled")); receivedSignal.throwIfAborted();
  });
  await runSupplierSearch({ adapter, sessionManager: manager(), query: { article: "A1" }, signal: controller.signal, emit: (event) => events.push(event) });
  assert.equal(events.filter((event) => event.type === "result").length, 0);
  assert.equal(events.some((event) => event.status === "error"), false);
});

test("Autopiter credentials survive restart encrypted and logout prevents late authorization from restoring them", async () => {
  const directory = mkdtempSync(join(tmpdir(), "autopiter-session-"));
  const path = join(directory, "credentials.enc.json");
  try {
    const store = new EncryptedSupplierCredentialStore(path, Buffer.alloc(32, 7));
    const sessions = manager();
    let verify = async () => cookie;
    const operations = { verifyAutopiterCredentials: (...args) => verify(...args) };
    const service = new SupplierSessionService([new AutopiterApiAdapter()], sessions, operations, store);
    await service.authorizeAutopiter(credentials, signal());
    const encrypted = readFileSync(path, "utf8");
    assert.doesNotMatch(encrypted, /123456|test-password|fixture-cookie/);
    assert.deepEqual(new EncryptedSupplierCredentialStore(path, Buffer.alloc(32, 7)).get("autopiter"), credentials);
    const restarted = new SupplierSessionManager();
    restarted.setAutopiterCredentials(store.get("autopiter")); restarted.markAuthorized("autopiter");
    const recovery = new SupplierSessionService([new AutopiterApiAdapter()], restarted, operations, store);
    assert.equal((await recovery.validateSupplierSessions("A1", ["autopiter"], signal())).results[0].status, "connected");
    assert.equal(restarted.getAutopiterCookie(), cookie);
    let release;
    verify = () => new Promise((resolve) => { release = resolve; });
    const pending = service.authorizeAutopiter(credentials, signal());
    const rejected = assert.rejects(pending, /invalidated/i);
    service.logoutAutopiter(); release(cookie); await rejected;
    assert.equal(store.get("autopiter"), null);
    assert.equal(sessions.getAutopiterCookie(), null);
    assert.equal(sessions.getSession("autopiter").authorized, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
