import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { SupplierAuthError, SupplierIntegrationError, SupplierTimeoutError } from "../src/backend/errors.ts";
import { createAggregatorServer } from "../src/backend/http/create-server.ts";

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
    authorizeMotorDetal: async () => session("motordetal", true),
    authorizeMladov: async () => session("mladov", true),
    logoutRossko: () => session("rossko"),
    logoutArmtek: () => session("armtek"),
    logoutPartKom: () => session("part-kom"),
    logoutStparts: () => session("stparts"),
    logoutMotorDetal: () => session("motordetal"),
    logoutMladov: () => session("mladov"),
    streamSearch: async () => {},
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
  assert.deepEqual(parseSseEvents(await response.text()), expectedEvents);
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
