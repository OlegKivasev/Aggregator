import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutopiterApiAdapter, verifyAutopiterCredentials } from "../src/backend/suppliers/autopiter/autopiter-api-adapter.ts";
import { SupplierSessionManager } from "../src/backend/session/session-manager.ts";
import { SupplierSessionService } from "../src/backend/application/supplier-session-service.ts";
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

test("Autopiter authorizes with client number and preserves password, accepting only the documented cookie", async () => {
  const received = [];
  assert.equal(await verifyAutopiterCredentials(credentials, signal(), async (...args) => {
    received.push(args); return response("Authorization", "true", { setCookie: ["unrelated=ignore; Path=/", `${cookie}; HttpOnly; Secure; Path=/`] });
  }), cookie);
  assert.equal(received[0][0], "Authorization");
  assert.deepEqual(received[0][1], { UserID: "123456", Password: " test-password ", Save: "false" });
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
  assert.equal(adapter.searchAnalogs, undefined);
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
