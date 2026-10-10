import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { SupplierAuthError, SupplierIntegrationError, SupplierTimeoutError } from "../src/backend/errors.ts";
import { createAggregatorServer } from "../src/backend/http/create-server.ts";
import { PartsApiApplicabilityClient } from "../src/backend/applicability/partsapi-client.ts";
import { ApplicabilityApplicationService } from "../src/backend/applicability/applicability-application-service.ts";
import { EncryptedApplicabilityApiKeyStore } from "../src/backend/applicability/encrypted-api-key-store.ts";
import { SqliteApplicabilityCacheRepository } from "../src/backend/applicability/sqlite-applicability-cache-repository.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const publicDir = join(process.cwd(), "src", "frontend");
const openServers = new Set();

function session(supplier, authorized = false) {
  return {
    supplier,
    authorized,
    lastCheckedAt: null,
    lastAuthorizedAt: null,
  };
}

function createApplication(overrides = {}) {
  return {
    listSupplierSessions: () => [],
    validateSupplierSessions: async () => ({ results: [], sessions: [] }),
    authorizeRossko: async () => session("rossko", true),
    authorizeArmtek: async () => session("armtek", true),
    authorizePartKom: async () => session("part-kom", true),
    authorizeStparts: async () => session("stparts", true),
    authorizeForumAuto: async () => session("forum-auto", true),
    authorizeMotorDetal: async () => session("motordetal", true),
    authorizeMladov: async () => session("mladov", true),
    logoutRossko: () => session("rossko"),
    logoutArmtek: () => session("armtek"),
    logoutPartKom: () => session("part-kom"),
    logoutStparts: () => session("stparts"),
    logoutForumAuto: () => session("forum-auto"),
    logoutMotorDetal: () => session("motordetal"),
    logoutMladov: () => session("mladov"),
    streamSearch: async () => {},
    searchApplicability: async () => ({ results: [], cacheHit: false }),
    getApplicabilityCachedBrands: () => [],
    listApplicabilitySavedArticles: () => ({ articles: [], brandCounts: [], hasMore: false }),
    getApplicabilitySavedArticle: () => null,
    deleteApplicabilitySavedArticle: () => false,
    getApplicabilityApiKeyState: () => ({ configured: false, persistent: true, maskedKey: null }),
    saveApplicabilityApiKey: () => ({ configured: true, persistent: true, maskedKey: "…t-key" }),
    deleteApplicabilityApiKey: () => ({ configured: false, persistent: true, maskedKey: null }),
    ...overrides,
  };
}

async function listen(application, reportError) {
  const server = createAggregatorServer({ application, publicDir, reportError });
  openServers.add(server);
  await new Promise((resolve, reject) => {
    const handleError = (error) => reject(error);
    server.once("error", handleError);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", handleError);
      resolve();
    });
  });
  const address = server.address();
  assert.notEqual(typeof address, "string");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function parseSseEvents(body) {
  return body
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => JSON.parse(block.slice("data: ".length)));
}

afterEach(async () => {
  await Promise.all([...openServers].map(async (server) => {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    openServers.delete(server);
  }));
});

test("HTTP server delegates authorization to the injected application", async () => {
  let receivedCredentials;
  const application = createApplication({
    authorizeArmtek: async (credentials) => {
      receivedCredentials = credentials;
      return session("armtek", true);
    },
  });
  const { baseUrl } = await listen(application);

  const response = await fetch(`${baseUrl}/api/suppliers/armtek/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: "api-user", password: " secret " }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(receivedCredentials, { login: "api-user", password: " secret " });
  assert.deepEqual(await response.json(), { session: session("armtek", true) });
});

test("HTTP server stores the applicability API key without exposing it to searches", async () => {
  let receivedQuery;
  let savedApiKey;
  const application = createApplication({
    searchApplicability: async (query) => {
      receivedQuery = query;
      return {
        cacheHit: false,
        results: [{
          carId: 31251,
          carName: "1.4 16V",
          carType: "PC",
          makeName: "LADA",
          modelName: "KALINA Saloon (1118)",
          yearEnd: "12.2013",
          yearStart: "09.2006",
        }],
      };
    },
    getApplicabilityApiKeyState: () => ({ configured: Boolean(savedApiKey), persistent: true, maskedKey: savedApiKey ? "…t-key" : null }),
    saveApplicabilityApiKey: (apiKey) => {
      savedApiKey = apiKey;
      return { configured: true, persistent: true, maskedKey: savedApiKey ? "…t-key" : null };
    },
    deleteApplicabilityApiKey: () => {
      savedApiKey = null;
      return { configured: false, persistent: true, maskedKey: savedApiKey ? "…t-key" : null };
    },
  });
  const { baseUrl } = await listen(application);

  const initialState = await fetch(`${baseUrl}/api/applicability/api-key`);
  assert.deepEqual(await initialState.json(), { configured: false, persistent: true, maskedKey: null });

  const saveResponse = await fetch(`${baseUrl}/api/applicability/api-key`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: " test-key " }),
  });
  assert.deepEqual(await saveResponse.json(), { configured: true, persistent: true, maskedKey: "…t-key" });
  assert.equal(savedApiKey, "test-key");

  const response = await fetch(`${baseUrl}/api/applicability/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sku: " 11182905003 ", brand: " LADA " }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(receivedQuery, { sku: "11182905003", brand: "LADA" });
  const responsePayload = await response.json();
  assert.equal(responsePayload.results[0].makeName, "LADA");
  assert.equal(responsePayload.cacheHit, false);

  const deleteResponse = await fetch(`${baseUrl}/api/applicability/api-key`, { method: "DELETE" });
  assert.deepEqual(await deleteResponse.json(), { configured: false, persistent: true, maskedKey: null });
  assert.equal(savedApiKey, null);

  const invalid = await fetch(`${baseUrl}/api/applicability/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sku: "", brand: "" }),
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { message: "Applicability request is invalid" });
});

test("HTTP server returns cached applicability brands for an article", async () => {
  const application = createApplication({
    getApplicabilityCachedBrands: (sku) => {
      assert.equal(sku, "2170-2915004");
      return ["LADA"];
    },
  });
  const { baseUrl } = await listen(application);

  const response = await fetch(`${baseUrl}/api/applicability/cached-brands?sku=2170-2915004`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { brands: ["LADA"] });
});

test("HTTP applicability searches use one key and removed key management routes cannot be called", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "partsapi-http-"));
  const apiKey = "fictional-http-key-AAAAA";
  const store = new EncryptedApplicabilityApiKeyStore(join(directory, "keys.enc.json"), Buffer.alloc(32, 9));
  const cache = new SqliteApplicabilityCacheRepository(join(directory, "cache.sqlite"));
  store.set(apiKey);
  const requests = [];
  const client = new PartsApiApplicabilityClient(async (url) => {
    requests.push(url.searchParams.get("key"));
    return Response.json({ error_code: 5000, message: "Exceeded the number of requests from the current IP address.", status: 401 }, { status: 401 });
  });
  const service = new ApplicabilityApplicationService(client, store, cache);
  const { server, baseUrl } = await listen(createApplication({
    searchApplicability: (query, signal) => service.search(query, signal),
    getApplicabilityApiKeyState: () => service.getApiKeyState(),
  }), () => {});
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    openServers.delete(server);
    cache.close();
    rmSync(directory, { recursive: true, force: true });
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const search = await fetch(`${baseUrl}/api/applicability/search`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sku: "OEM1", brand: "FORD" }) });
    assert.equal(search.status, 401);
    assert.deepEqual(await search.json(), { message: "PartsAPI отклонил запрос для ключа …AAAAA. Проверьте ключ и подписку." });
  }
  assert.deepEqual(requests, [apiKey, apiKey]);
  const state = await (await fetch(`${baseUrl}/api/applicability/api-key`)).json();
  assert.deepEqual(state, { configured: true, persistent: true, maskedKey: "…AAAAA" });
  for (const [path, method, payload] of [
    ["fallbacks", "POST", { apiKey: "fictional-standby" }],
    ["fallbacks/0", "DELETE", null],
    ["active", "PUT", { index: 0 }],
  ]) {
    const response = await fetch(`${baseUrl}/api/applicability/api-key/${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    assert.equal(response.status, 405);
  }
});

test("HTTP applicability failures expose a safe masked-key notice without raw rejection details", async () => {
  const events = [];
  const apiKey = "private-test-key-ABCDE";
  let upstreamStatus = 403;
  let upstreamBody = `Request limit exceeded for ${apiKey}; internal diagnostic`;
  const client = new PartsApiApplicabilityClient(async () => new Response(upstreamBody, { status: upstreamStatus }));
  const { baseUrl } = await listen(createApplication({
    searchApplicability: (query, signal) => client.search({ ...query, apiKey }, signal),
  }), (event) => events.push(event));
  for (const status of [403, 429, 401]) {
    const limitExceeded = status !== 401;
    upstreamStatus = status;
    upstreamBody = limitExceeded
      ? `Request limit exceeded for ${apiKey}; internal diagnostic`
      : `Invalid key ${apiKey}; internal diagnostic`;
    const response = await fetch(`${baseUrl}/api/applicability/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sku: "OEM1", brand: "FORD" }),
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { message: "PartsAPI отклонил запрос для ключа …ABCDE. Проверьте ключ и подписку." });
  }
  assert.deepEqual(events, [
    { operation: "search-applicability", category: "authorization" },
    { operation: "search-applicability", category: "authorization" },
    { operation: "search-applicability", category: "authorization" },
  ]);
});

test("HTTP server lists, opens and deletes saved OEM pairs without external searches", async () => {
  const article = { sku: "OEM/1", brand: "VOLVO" };
  const savedArticle = { ...article, hasResults: true };
  const brandCounts = [{ brand: "VOLVO", found: 1, notFound: 0 }];
  const vehicle = { carId: 1, carName: "2.0", carType: "PC", makeName: "VOLVO", modelName: "Test", yearStart: null, yearEnd: null };
  let saved = true;
  const { baseUrl } = await listen(createApplication({
    searchApplicability: async () => { throw new Error("must not call PartsAPI"); },
    listApplicabilitySavedArticles: (query) => {
      assert.deepEqual(query, { search: "OEM", offset: 0, order: "sku", includeNotFound: false });
      return { articles: saved ? [savedArticle] : [], brandCounts: saved ? brandCounts : [], hasMore: false };
    },
    getApplicabilitySavedArticle: (query) => {
      assert.deepEqual(query, article);
      return saved ? [vehicle] : null;
    },
    deleteApplicabilitySavedArticle: (query) => {
      assert.deepEqual(query, article);
      const deleted = saved;
      saved = false;
      return deleted;
    },
  }));
  const listPath = `${baseUrl}/api/applicability/saved-articles?search=OEM&order=sku`;
  assert.deepEqual(await (await fetch(listPath)).json(), { articles: [savedArticle], brandCounts, hasMore: false });
  const resultPath = `${baseUrl}/api/applicability/saved-articles/result?${new URLSearchParams(article)}`;
  assert.deepEqual(await (await fetch(resultPath)).json(), { results: [vehicle] });
  const deleteOptions = { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(article) };
  assert.deepEqual(await (await fetch(`${baseUrl}/api/applicability/saved-articles`, deleteOptions)).json(), { deleted: true });
  assert.deepEqual(await (await fetch(`${baseUrl}/api/applicability/saved-articles`, deleteOptions)).json(), { deleted: false });
  assert.equal((await fetch(resultPath)).status, 404);
  assert.deepEqual(await (await fetch(listPath)).json(), { articles: [], brandCounts: [], hasMore: false });
});

test("HTTP server hides OEM entries without results by default and accepts an explicit opt-in", async () => {
  const queries = [];
  const { baseUrl } = await listen(createApplication({
    listApplicabilitySavedArticles: (query) => { queries.push(query); return { articles: [], brandCounts: [], hasMore: false }; },
  }));
  for (const query of ["", "?includeNotFound=true", "?includeNotFound=false"]) {
    assert.equal((await fetch(`${baseUrl}/api/applicability/saved-articles${query}`)).status, 200);
  }
  assert.deepEqual(queries.map((query) => query.includeNotFound), [false, true, false]);
});

test("HTTP server validates saved OEM queries and redacts storage errors", async () => {
  const reports = [];
  const { baseUrl } = await listen(createApplication({
    listApplicabilitySavedArticles: () => { throw new Error("secret internal path"); },
  }), (event) => reports.push(event));
  for (const query of ["offset=-1", "offset=1.5", "offset=1000001", "order=unknown", `search=${"a".repeat(129)}`, "search=%00", "includeNotFound=1", "includeNotFound=TRUE", "includeNotFound="]) {
    const response = await fetch(`${baseUrl}/api/applicability/saved-articles?${query}`);
    assert.equal(response.status, 400);
  }
  assert.equal((await fetch(`${baseUrl}/api/applicability/saved-articles/result?sku=SKU`)).status, 400);
  assert.equal((await fetch(`${baseUrl}/api/applicability/saved-articles`, {
    method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{invalid",
  })).status, 400);
  const failure = await fetch(`${baseUrl}/api/applicability/saved-articles`);
  assert.equal(failure.status, 500);
  assert.equal((await failure.json()).message, "Applicability search failed");
  assert.equal(reports.length, 1);
});

test("HTTP server delegates Forum-Auto authorization without exposing credentials", async () => {
  let receivedCredentials;
  const application = createApplication({
    authorizeForumAuto: async (credentials) => {
      receivedCredentials = credentials;
      return session("forum-auto", true);
    },
  });
  const { baseUrl } = await listen(application);

  const response = await fetch(`${baseUrl}/api/suppliers/forum-auto/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: "api-user", password: " secret " }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(receivedCredentials, { login: "api-user", password: " secret " });
  assert.deepEqual(await response.json(), { session: session("forum-auto", true) });
});

test("HTTP server transports mixed supplier SSE events without changing them", async () => {
  const expectedEvents = [
    { type: "search_started", article: "ABC-123", suppliers: ["rossko", "armtek"] },
    { type: "supplier_status", supplier: "rossko", status: "searching" },
    { type: "supplier_status", supplier: "armtek", status: "searching" },
    {
      type: "result",
      result: {
        supplier: "rossko",
        brand: "Brand",
        article: "ABC-123",
        title: "Part",
        price: 100,
        warehouse: null,
        deliveryDate: null,
        deliveryDateApproximate: false,
        link: "https://rossko.ru/product",
      },
    },
    { type: "supplier_status", supplier: "rossko", status: "completed" },
    { type: "supplier_status", supplier: "armtek", status: "timeout", details: "Supplier search timed out" },
    { type: "search_completed", article: "ABC-123" },
  ];
  const application = createApplication({
    streamSearch: async (query, emit) => {
      assert.deepEqual(query, { article: "ABC-123", suppliers: ["rossko", "armtek"] });
      for (const event of expectedEvents) {
        emit(event);
      }
    },
  });
  const { baseUrl } = await listen(application);

  const response = await fetch(`${baseUrl}/api/search?stream=once&article=ABC-123&supplier=rossko&supplier=armtek`);

  assert.equal(response.status, 200);
  const events = parseSseEvents(await response.text());
  const result = events.find((event) => event.type === "result");
  assert.match(result.offerId, /^[0-9a-f-]{36}$/i);
  delete result.offerId;
  assert.deepEqual(events, expectedEvents);
});

test("HTTP server parses Rossko K1 and K2 without exposing them", async () => {
  let receivedCredentials;
  const application = createApplication({
    authorizeRossko: async (credentials) => {
      receivedCredentials = credentials;
      return session("rossko", true);
    },
  });
  const { baseUrl } = await listen(application);

  const response = await fetch(`${baseUrl}/api/suppliers/rossko/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key1: " first-key ", key2: " second-key " }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(receivedCredentials, { key1: "first-key", key2: "second-key" });
  assert.deepEqual(await response.json(), { session: session("rossko", true) });
});

test("HTTP server validates and transports an analog search query", async () => {
  let receivedQuery;
  const application = createApplication({
    streamSearch: async (query, emit) => {
      receivedQuery = query;
      emit({ type: "search_started", article: query.article, suppliers: ["armtek"] });
      emit({ type: "search_completed", article: query.article });
    },
  });
  const { baseUrl } = await listen(application);

  const missingBrand = await fetch(`${baseUrl}/api/search?stream=once&mode=analogs&article=ABC-123&supplier=armtek`);
  assert.equal(missingBrand.status, 400);

  const response = await fetch(`${baseUrl}/api/search?stream=once&mode=analogs&article=ABC-123&brand=Brand&supplier=armtek`);

  assert.equal(response.status, 200);
  assert.deepEqual(receivedQuery, {
    mode: "analogs",
    article: "ABC-123",
    brand: "Brand",
    suppliers: ["armtek"],
  });
  assert.deepEqual(parseSseEvents(await response.text()), [
    { type: "search_started", article: "ABC-123", suppliers: ["armtek"] },
    { type: "search_completed", article: "ABC-123" },
  ]);
});

test("HTTP server validates and transports a brand discovery query", async () => {
  let receivedQuery;
  const application = createApplication({
    streamSearch: async (query, emit) => {
      receivedQuery = query;
      emit({ type: "search_started", article: query.article, suppliers: ["armtek"] });
      emit({ type: "brand_candidates", supplier: "armtek", brands: ["Brand"] });
      emit({ type: "search_completed", article: query.article });
    },
  });
  const { baseUrl } = await listen(application);
  const response = await fetch(`${baseUrl}/api/search?stream=once&mode=brands&article=ABC-123&supplier=armtek`);

  assert.equal(response.status, 200);
  assert.deepEqual(receivedQuery, {
    mode: "brands",
    article: "ABC-123",
    suppliers: ["armtek"],
  });
  assert.deepEqual(parseSseEvents(await response.text()), [
    { type: "search_started", article: "ABC-123", suppliers: ["armtek"] },
    { type: "brand_candidates", supplier: "armtek", brands: ["Brand"] },
    { type: "search_completed", article: "ABC-123" },
  ]);
});

test("HTTP server aborts injected search work when the client disconnects", async () => {
  let resolveAbort;
  const abortObserved = new Promise((resolve) => {
    resolveAbort = resolve;
  });
  const application = createApplication({
    streamSearch: async (_query, emit, signal) => {
      emit({ type: "search_started", article: "ABC-123", suppliers: [] });
      await new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          resolveAbort(signal.reason);
          resolve();
        }, { once: true });
      });
    },
  });
  const { baseUrl } = await listen(application);
  const response = await fetch(`${baseUrl}/api/search?stream=once&article=ABC-123`);
  const reader = response.body.getReader();

  const firstChunk = await reader.read();
  assert.equal(firstChunk.done, false);
  await reader.cancel();

  const reason = await Promise.race([
    abortObserved,
    once(AbortSignal.timeout(2_000), "abort").then(() => {
      throw new Error("Search abort was not observed");
    }),
  ]);
  assert.match(reason.message, /Client disconnected/);
});

test("HTTP server aborts authorization when the client disconnects", async () => {
  let resolveStarted;
  let resolveAbort;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  const abortObserved = new Promise((resolve) => {
    resolveAbort = resolve;
  });
  const application = createApplication({
    authorizeArmtek: async (_credentials, signal) => {
      resolveStarted();
      await new Promise((resolve) => signal.addEventListener("abort", () => {
        resolveAbort(signal.reason);
        resolve();
      }, { once: true }));
      throw signal.reason;
    },
  });
  const { baseUrl } = await listen(application);
  const url = new URL("/api/suppliers/armtek/authorize", baseUrl);
  const request = httpRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  request.on("error", () => undefined);
  request.end(JSON.stringify({ login: "api-user", password: "secret" }));

  await started;
  request.destroy();
  const reason = await Promise.race([
    abortObserved,
    once(AbortSignal.timeout(2_000), "abort").then(() => {
      throw new Error("Authorization abort was not observed");
    }),
  ]);
  assert.match(reason.message, /Client disconnected/);
});

test("HTTP server redacts authorization failures", async () => {
  const reportedErrors = [];
  const application = createApplication({
    authorizeArmtek: async () => {
      throw new SupplierIntegrationError("private upstream URL https://private.invalid/?token=secret");
    },
  });
  const { baseUrl } = await listen(application, (event) => reportedErrors.push(event));

  const response = await fetch(`${baseUrl}/api/suppliers/armtek/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: "api-user", password: "secret" }),
  });

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { message: "Supplier authorization failed" });
  assert.deepEqual(reportedErrors, [{ operation: "authorize-armtek", category: "integration" }]);
});

test("HTTP server returns only explicitly safe supplier integration messages", async () => {
  const reportedErrors = [];
  const application = createApplication({
    authorizePartKom: async () => {
      throw new SupplierIntegrationError("private upstream details", {
        publicMessage: "PartKOM API access is not allowed from this server IP address",
        diagnosticCode: "partkom_ip_restricted",
      });
    },
  });
  const { baseUrl } = await listen(application, (event) => reportedErrors.push(event));

  const response = await fetch(`${baseUrl}/api/suppliers/part-kom/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: "api-user", password: "secret" }),
  });

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    message: "PartKOM API access is not allowed from this server IP address",
  });
  assert.deepEqual(reportedErrors, [{
    operation: "authorize-part-kom",
    category: "integration",
    diagnosticCode: "partkom_ip_restricted",
  }]);
});

test("HTTP server maps typed authorization errors to stable statuses", async () => {
  const scenarios = [
    { error: new SupplierAuthError("private auth detail"), status: 401, category: "authorization" },
    { error: new SupplierTimeoutError("private timeout detail"), status: 504, category: "timeout" },
    { error: new Error("private internal detail"), status: 500, category: "internal" },
  ];

  for (const scenario of scenarios) {
    const reportedErrors = [];
    const application = createApplication({
      authorizeArmtek: async () => {
        throw scenario.error;
      },
    });
    const { server, baseUrl } = await listen(application, (event) => reportedErrors.push(event));
    const response = await fetch(`${baseUrl}/api/suppliers/armtek/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: "api-user", password: "secret" }),
    });

    assert.equal(response.status, scenario.status);
    assert.deepEqual(await response.json(), { message: "Supplier authorization failed" });
    assert.deepEqual(reportedErrors, [{ operation: "authorize-armtek", category: scenario.category }]);
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    openServers.delete(server);
  }
});

test("HTTP server redacts fatal search failures", async () => {
  const reportedErrors = [];
  const application = createApplication({
    streamSearch: async () => {
      throw new Error("private path C:\\state\\token.json");
    },
  });
  const { baseUrl } = await listen(application, (event) => reportedErrors.push(event));

  const response = await fetch(`${baseUrl}/api/search?stream=once&article=ABC-123`);

  assert.deepEqual(parseSseEvents(await response.text()), [{ type: "fatal_error", message: "Search failed" }]);
  assert.deepEqual(reportedErrors, [{ operation: "stream-search", category: "internal" }]);
});

test("HTTP server can be constructed without opening a listening socket", () => {
  const server = createAggregatorServer({ application: createApplication(), publicDir });
  assert.equal(server.listening, false);
});

test("HTTP server serves applicability action icons as PNG files", async () => {
  const application = createApplication();
  const { baseUrl } = await listen(application);

  const response = await fetch(`${baseUrl}/applicability-save.png`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal((await response.arrayBuffer()).byteLength > 0, true);

  const deleteIconResponse = await fetch(`${baseUrl}/applicability-key-delete.png`);
  assert.equal(deleteIconResponse.status, 200);
  assert.equal(deleteIconResponse.headers.get("content-type"), "image/png");
  assert.equal((await deleteIconResponse.arrayBuffer()).byteLength > 0, true);
});
