import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import { armtekSearchItems, armtekVkorgItems, parseArmtekDeliveryDates } from "../src/backend/suppliers/armtek/armtek-api-adapter.ts";
import { createHash } from "node:crypto";
import { parseArmtekApiAccountState } from "../src/backend/suppliers/armtek/armtek-api-account-state.ts";
import { findPrimaryPartKomMakerId, isPartKomUnauthorizedResponse } from "../src/backend/suppliers/part-kom/part-kom-api-adapter.ts";
import { rosskoExactProductIds } from "../src/backend/suppliers/rossko/rossko-site-api-adapter.ts";
import { createStpartsBatchParams, parseStpartsApiResults, StpartsApiAdapter } from "../src/backend/suppliers/stparts/stparts-api-adapter.ts";
import { gotoStparts, isStpartsSessionPageAuthorized } from "../src/backend/suppliers/stparts/stparts-site-auth.ts";
import { runSupplierSearch } from "../src/backend/suppliers/run-supplier-search.ts";
import { SupplierAuthError } from "../src/backend/suppliers/errors.ts";
import { SupplierSessionManager } from "../src/backend/session/session-manager.ts";
import { buildIncompleteSearchWarnings, buildSupplierResultTooltip, formatDeliveryDate } from "../src/frontend/supplier-search-summary.js";
import { SupplierTimeoutError } from "../src/backend/suppliers/errors.ts";
import { isPartKomAuthenticated } from "../src/backend/suppliers/part-kom/part-kom-site-auth.ts";

const port = 31847;
const baseUrl = `http://127.0.0.1:${port}`;

test("Armtek keeps both delivery interval dates", () => {
  const dates = parseArmtekDeliveryDates("20260725", "20260728");

  assert.ok(dates.deliveryDate);
  assert.ok(dates.deliveryDateTo);
  assert.ok(Date.parse(dates.deliveryDate) < Date.parse(dates.deliveryDateTo));
  assert.equal(new Date(dates.deliveryDate).getDate(), 25);
  assert.equal(new Date(dates.deliveryDateTo).getDate(), 28);
});

test("Armtek rejects impossible calendar delivery dates", () => {
  assert.deepEqual(parseArmtekDeliveryDates("20260230", undefined), {
    deliveryDate: null,
    deliveryDateTo: null,
  });
});

test("Armtek accepts the direct VKORG array returned by WebService", () => {
  assert.deepEqual(armtekVkorgItems([{ VKORG: "4000" }]), [{ VKORG: "4000" }]);
  assert.deepEqual(armtekVkorgItems({ ARRAY: { VKORG: "4000" } }), [{ VKORG: "4000" }]);
});

test("Armtek accepts the direct search array returned by WebService", () => {
  assert.deepEqual(armtekSearchItems([{ PIN: "90915YZZJ1", PRICE: "691.22" }]), [{ PIN: "90915YZZJ1", PRICE: "691.22" }]);
});

test("Armtek account state is accepted only for the login that discovered it", () => {
  const login = "test-account";
  const loginHash = createHash("sha256").update(login).digest("hex");
  const state = { loginHash, vkorg: "4000", kunnrRg: "123456" };

  assert.deepEqual(parseArmtekApiAccountState(state, login), { vkorg: "4000", kunnrRg: "123456" });
  assert.equal(parseArmtekApiAccountState(state, "another-account"), null);
  assert.equal(parseArmtekApiAccountState({ ...state, kunnrRg: "" }, login), null);
});

test("Rossko keeps every exact article product returned by web search", () => {
  assert.deepEqual(rosskoExactProductIds({
    results: [
      { searchResults: [{ id: "bardahl", article: "1072", part: { price: 1613 } }, { id: "other", article: "01072", part: { price: 100 } }] },
      { searchResults: [{ id: "smilga", article: "1072", part: { price: 35.175 } }, { id: "without-price", article: "1072" }, { id: "bardahl", article: "1072", part: { price: 1613 } }] },
    ],
  }, "1072"), ["bardahl", "smilga"]);
});

test("Part-Kom selects the primary autocomplete maker for the requested normalized article", () => {
  const makerId = findPrimaryPartKomMakerId([
    { maker_id: 10, number: "VAP-021-2375", maker: "ВОЛГААВТОПРОМ" },
    { maker_id: 20, number: "VAP0212375", maker: "Россия" },
    { maker_id: 30, number: "VAP-021-2375A", maker: "RUSSIA" },
    { maker_id: 40, number: "VAP-021-237", maker: "RUSSIA" },
    { maker_id: 50, number: undefined, maker: "RUSSIA" },
  ], "VAP0212375");

  assert.equal(makerId, "10");
});

test("Part-Kom recognizes its unauthorized JSON response", () => {
  assert.equal(isPartKomUnauthorizedResponse({ success: false, message: "unauthorized", msg: "unauthorized" }), true);
  assert.equal(isPartKomUnauthorizedResponse({ success: false, message: "temporarily unavailable" }), false);
});

test("STParts normalizes exact API offers", () => {
  const results = parseStpartsApiResults({ "VAP0212375": {
    availability: "38",
    brand: "ВолгаАвтоПром",
    deliveryPeriod: 24,
    description: "ВАЛ КАРДАННЫЙ ВАЗ-2121 ЗАДНИЙ",
    supplierDescription: '<b><font color="green">OD880</font></b>',
    number: "VAP-021-2375",
    price: 6900.27,
    supplierColor: "D5F5D9",
  } }, "VAP-021-2375");

  assert.equal(results.length, 1);
  assert.equal(results[0].price, 6900.27);
  assert.equal(results[0].warehouse, "OD880");
  assert.equal(results[0].warehouseColor, "green");
});

test("STParts reads warehouse color from supplier description HTML", () => {
  const quoted = parseStpartsApiResults([{
    availability: 1,
    brand: "Brand",
    description: "Part",
    number: "ABC-123",
    price: 100,
    supplierDescription: '<font color="#0000ff">POS123</font>',
  }], "ABC-123");
  const unquoted = parseStpartsApiResults([{
    availability: 1,
    brand: "Brand",
    description: "Part",
    number: "ABC-123",
    price: 100,
    supplierDescription: "<font color=red>POS456</font>",
  }], "ABC-123");

  assert.equal(quoted[0].warehouseColor, "blue");
  assert.equal(unquoted[0].warehouseColor, "red");
});

test("STParts accepts a CSS hex supplier color", () => {
  const results = parseStpartsApiResults([{
    availability: 1,
    brand: "Brand",
    description: "Part",
    number: "ABC-123",
    price: 100,
    supplierColor: "#0000ff",
    supplierDescription: "POS123",
  }], "ABC-123");

  assert.equal(results[0].warehouseColor, "blue");
});

test("STParts omits a duplicate delivery interval end", () => {
  const results = parseStpartsApiResults([{
    availability: 1,
    brand: "Stellox",
    deliveryPeriod: 48,
    deliveryPeriodMax: 48,
    description: "Part",
    number: "0590554SX",
    price: 4669,
  }], "0590554SX");

  assert.ok(results[0].deliveryDate);
  assert.equal(results[0].deliveryDateTo, null);
});

test("delivery formatter omits equal calendar dates", () => {
  assert.equal(formatDeliveryDate("2026-07-26T00:00:00.000Z", true, "2026-07-26T12:00:00.000Z"), "~26.07.2026");
  assert.equal(formatDeliveryDate("2026-07-26T00:00:00.000Z", true, "2026-07-27T00:00:00.000Z"), "~26.07.2026 - 27.07.2026");
});

test("STParts rejects malformed and non-exact API offers", () => {
  const results = parseStpartsApiResults([
    { brand: "Brand", number: "ABC-123", description: "Part", price: 100, availability: 1 },
    { brand: "Brand", number: "ABC-1234", description: "Other", price: 100, availability: 1 },
    { brand: "Brand", number: "ABC-123", description: "No price", price: 0, availability: 1 },
  ], "ABC-123");

  assert.deepEqual(results.map((result) => result.title), ["Part"]);
});

test("STParts treats an empty API result map as no offers", () => {
  assert.deepEqual(parseStpartsApiResults({}, "1072"), []);
});

test("STParts splits batch searches at the ABCP limit", () => {
  const batches = createStpartsBatchParams(Array.from({ length: 101 }, (_value, index) => `Brand ${index}`), "ABC-123");

  assert.equal(batches.length, 2);
  assert.equal(batches[0].get("search[99][brand]"), "Brand 99");
  assert.equal(batches[1].get("search[0][brand]"), "Brand 100");
  assert.equal(batches[1].get("search[0][number]"), "ABC-123");
});

test("STParts batches brands and caches repeated searches", async () => {
  const calls = [];
  const requester = async (path, params, _signal, _timeoutMs, _credentials, options) => {
    calls.push({ path, params: new URLSearchParams(params), method: options?.method ?? "GET" });
    if (path === "search/brands/") {
      return [{ brand: "Brand A" }, { brand: "Brand B" }, { brand: "Brand A" }];
    }
    return [{ brand: "Brand A", number: "ABC-123", description: "Part", price: 100, availability: 1 }];
  };
  const adapter = new StpartsApiAdapter(requester);
  const sessionManager = new SupplierSessionManager();
  sessionManager.setStpartsCredentials({ login: "test", password: "secret" });
  const results = [];
  const context = { signal: new AbortController().signal, timeoutMs: 1000 };

  await Promise.all([
    adapter.search({ article: "ABC-123" }, context, (result) => results.push(result), sessionManager),
    adapter.search({ article: "ABC123" }, context, (result) => results.push(result), sessionManager),
  ]);
  await adapter.search({ article: "ABC-123" }, context, (result) => results.push(result), sessionManager);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => [call.path, call.method]), [["search/brands/", "GET"], ["search/batch", "POST"]]);
  assert.equal(calls[0].params.get("useOnlineStocks"), "0");
  assert.equal(calls[1].params.get("search[0][brand]"), "Brand A");
  assert.equal(calls[1].params.get("search[1][brand]"), "Brand B");
  assert.equal(results.length, 3);
});

test("STParts validates sessions without running a product search", async () => {
  const calls = [];
  const adapter = new StpartsApiAdapter(async (path) => {
    calls.push(path);
    return { id: "test-user" };
  });
  const sessionManager = new SupplierSessionManager();
  sessionManager.setStpartsCredentials({ login: "test", password: "secret" });

  await adapter.validateSession({ signal: new AbortController().signal, timeoutMs: 1000 }, sessionManager);

  assert.deepEqual(calls, ["user/info"]);
});

test("STParts allows fifteen seconds for the initial navigation by default", async () => {
  let gotoOptions;
  const page = {
    async goto(_url, options) {
      gotoOptions = options;
    },
    async waitForTimeout() {},
  };

  await gotoStparts(page, "https://stparts.ru/");

  assert.equal(gotoOptions.timeout, 15_000);
});

test("STParts identifies an expired stored session from its login page", () => {
  assert.equal(isStpartsSessionPageAuthorized('<form id="lgnform"><input name="login" /></form>'), false);
  assert.equal(isStpartsSessionPageAuthorized('<a href="/logout/">Logout</a>'), true);
});

test("STParts rejects an invalid API search payload", () => {
  assert.throws(() => parseStpartsApiResults("invalid", "ABC-123"), /invalid search response/);

});

test("Part-Kom rejects a failed authorization probe", async () => {
  const page = {
    async goto() {},
    async waitForTimeout() {},
    async waitForLoadState() {},
    async evaluate() {
      return { probeFailed: true };
    },
  };

  await assert.rejects(isPartKomAuthenticated(page), /authorization probe failed/);
});

test("supplier authentication failure triggers session disconnection", async () => {
  const sessionManager = new SupplierSessionManager();
  sessionManager.markAuthorized("stparts");
  let disconnected = false;
  const events = [];
  const adapter = {
    id: "stparts",
    displayName: "STParts",
    timeoutMs: 1000,
    async ensureSession() {
      return sessionManager.getSession("stparts");
    },
    async search() {
      throw new SupplierAuthError("expired");
    },
  };

  await runSupplierSearch({
    adapter,
    sessionManager,
    query: { article: "TEST-1" },
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
    onAuthError: () => {
      disconnected = true;
    },
  });

  assert.equal(disconnected, true);
  assert.equal(events.at(-1).status, "auth_error");
});

test("supplier search discards invalid results without stopping valid supplier output", async () => {
  const sessionManager = new SupplierSessionManager();
  sessionManager.markAuthorized("rossko");
  const events = [];
  const adapter = {
    id: "rossko",
    displayName: "Rossko",
    timeoutMs: 1000,
    async ensureSession() {
      return sessionManager.getSession("rossko");
    },
    async search(_query, _context, onResult) {
      onResult({
        supplier: "rossko",
        brand: "Brand",
        article: "ABC-123",
        title: "Part",
        price: 1,
        warehouse: null,
        deliveryDate: null,
        deliveryDateApproximate: false,
        link: "javascript:bad",
      });
      onResult({
        supplier: "rossko",
        brand: "Brand",
        article: "ABC-123",
        title: "Part",
        price: 1,
        warehouse: null,
        deliveryDate: null,
        deliveryDateApproximate: false,
        link: "https://rossko.ru/product",
      });
    },
  };

  await runSupplierSearch({
    adapter,
    sessionManager,
    query: { article: "ABC-123" },
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
  });

  assert.deepEqual(events.map((event) => event.type === "supplier_status" ? [event.status, event.details] : event.type), [
    ["searching", undefined],
    "result",
    ["completed", undefined],
  ]);
});

test("supplier search only recognizes typed timeout errors", async () => {
  const sessionManager = new SupplierSessionManager();
  sessionManager.markAuthorized("rossko");
  const events = [];
  const adapter = {
    id: "rossko",
    displayName: "Rossko",
    timeoutMs: 1000,
    async ensureSession() {
      return sessionManager.getSession("rossko");
    },
    async search() {
      throw new Error("response contains timeout marker https://private.invalid/?token=secret");
    },
  };

  await runSupplierSearch({ adapter, sessionManager, query: { article: "ABC-123" }, signal: new AbortController().signal, emit: (event) => events.push(event) });
  assert.deepEqual(events.at(-1), { type: "supplier_status", supplier: "rossko", status: "error", details: "Supplier search failed" });

  adapter.search = async () => {
    throw new SupplierTimeoutError("internal timeout details");
  };
  events.length = 0;
  await runSupplierSearch({ adapter, sessionManager, query: { article: "ABC-123" }, signal: new AbortController().signal, emit: (event) => events.push(event) });
  assert.deepEqual(events.at(-1), { type: "supplier_status", supplier: "rossko", status: "timeout", details: "Supplier search timed out" });
});

test("supplier search does not emit events for an already aborted request", async () => {
  const controller = new AbortController();
  controller.abort(new Error("Client disconnected"));
  const events = [];
  await runSupplierSearch({
    adapter: { id: "rossko", displayName: "Rossko", timeoutMs: 1000, async ensureSession() { throw new Error("unreachable"); }, async search() {} },
    sessionManager: new SupplierSessionManager(),
    query: { article: "ABC-123" },
    signal: controller.signal,
    emit: (event) => events.push(event),
  });
  assert.deepEqual(events, []);
});

test("session manager preserves password whitespace", () => {
  const sessionManager = new SupplierSessionManager();
  sessionManager.setArmtekCredentials({ login: " user ", password: " password " });
  assert.deepEqual(sessionManager.getArmtekCredentials(), { login: "user", password: " password " });
});

test("session manager keeps STParts API credentials only in runtime memory", () => {
  const sessionManager = new SupplierSessionManager();
  sessionManager.setStpartsCredentials({ login: "api-user", password: " password " });

  assert.deepEqual(sessionManager.getStpartsCredentials(), { login: "api-user", password: " password " });
  sessionManager.clearStpartsCredentials();
  assert.equal(sessionManager.getStpartsCredentials(), null);
});

test("incomplete search warnings list only failed suppliers", () => {
  assert.deepEqual(buildIncompleteSearchWarnings(
    ["rossko", "armtek", "part-kom", "stparts", "motordetal", "mladov"],
    {
      rossko: "completed",
      armtek: "completed",
      "part-kom": "timeout",
      stparts: "auth_error",
      motordetal: "error",
    },
    { rossko: "Rossko", armtek: "Armtek", "part-kom": "Part-Kom", stparts: "STParts", motordetal: "MotorDetal", mladov: "Механик Ладов" },
  ), [
    "Part-Kom: время ожидания истекло",
    "STParts: требуется авторизация",
    "MotorDetal: поиск не выполнен",
    "Механик Ладов: нет итогового ответа",
  ]);
});

test("supplier result tooltip includes duration for every selected supplier", () => {
  assert.equal(buildSupplierResultTooltip(
    ["rossko", "armtek"],
    [{ supplier: "rossko" }, { supplier: "rossko" }],
    { rossko: 38_200, armtek: 1_000 },
    { rossko: "Rossko", armtek: "Armtek" },
  ), "Rossko: 2 позиций (38,2 с)\nArmtek: 0 позиций (1,0 с)");
});

async function waitForServer(server) {
  const timeout = AbortSignal.timeout(10_000);

  while (!timeout.aborted) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: timeout });
      if (response.ok) {
        return;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  throw new Error("Server did not become ready within 10 seconds");
}

function requestWithHost(host) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path: "/api/health", headers: { Host: host } }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end();
  });
}

test("server production smoke test", async () => {
  const server = spawn(process.execPath, ["--experimental-strip-types", "src/backend/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    await waitForServer(server);

    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await requestWithHost("["), 200);

    const index = await fetch(`${baseUrl}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(await index.text(), /<!DOCTYPE html>/i);

    const oversizedBody = await fetch(`${baseUrl}/api/suppliers/rossko/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(17_000),
    });
    assert.equal(oversizedBody.status, 413);
    assert.deepEqual(await oversizedBody.json(), { message: "Request body is too large" });

    const malformedValidation = await fetch(`${baseUrl}/api/suppliers/sessions/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ article: "TEST-1", suppliers: ["unknown"] }),
    });
    assert.equal(malformedValidation.status, 400);
    assert.deepEqual(await malformedValidation.json(), { message: "suppliers must contain supported supplier IDs" });

    const traversal = await fetch(`${baseUrl}/%2e%2e/package.json`);
    assert.equal(traversal.status, 404);
  } finally {
    server.kill("SIGTERM");
    await once(server, "exit");
  }

  assert.equal(stderr, "");
});
