import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { armtekSearchItems, armtekVkorgItems, getArmtekAnalogSearchTargets, getArmtekWarehouse, getOptionalArmtekStoreNames, parseArmtekDeliveryDates } from "../src/backend/suppliers/armtek/armtek-api-adapter.ts";
import { createHash } from "node:crypto";
import { parseArmtekApiAccountState } from "../src/backend/suppliers/armtek/armtek-api-account-state.ts";
import { parsePartKomApiResponse, parsePartKomApiResults, PartKomApiAdapter, verifyPartKomApiCredentials } from "../src/backend/suppliers/part-kom/part-kom-api-adapter.ts";
import { rosskoExactProductIds } from "../src/backend/suppliers/rossko/rossko-site-api-adapter.ts";
import { createStpartsBatchParams, parseStpartsApiResults, StpartsApiAdapter } from "../src/backend/suppliers/stparts/stparts-api-adapter.ts";
import { gotoStparts, isStpartsSessionPageAuthorized } from "../src/backend/suppliers/stparts/stparts-site-auth.ts";
import { runSupplierSearch } from "../src/backend/suppliers/run-supplier-search.ts";
import { SupplierAuthError, SupplierIntegrationError, SupplierTimeoutError } from "../src/backend/suppliers/errors.ts";
import { SupplierSessionManager } from "../src/backend/session/session-manager.ts";
import { buildIncompleteSearchWarnings, buildSupplierResultTooltip, formatDeliveryDate } from "../src/frontend/supplier-search-summary.js";

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

test("Armtek requests analogs for every unique valid exact brand", () => {
  assert.deepEqual(getArmtekAnalogSearchTargets([
    { PIN: "90915-YZZJ1", BRAND: "TOYOTA", NAME: "Oil filter", PRICE: "505.07" },
    { PIN: "90915YZZJ1", BRAND: "toyota", NAME: "Oil filter", PRICE: "519.78" },
    { PIN: "90915YZZJ1", BRAND: "DENSO", NAME: "Oil filter", PRICE: "600" },
    { PIN: "90915YZZJ1", BRAND: "BOSCH", NAME: "Oil filter", PRICE: "610", ANALOG: "0" },
    { PIN: "90915YZZJ1", BRAND: "MANN", NAME: "Analog", PRICE: "450", ANALOG: "X" },
    { PIN: "OTHER", BRAND: "OTHER", NAME: "Other part", PRICE: "100" },
    { PIN: "90915YZZJ1", BRAND: "INVALID", NAME: "No price", PRICE: "0" },
  ], "90915YZZJ1"), [
    { article: "90915-YZZJ1", brand: "TOYOTA" },
    { article: "90915YZZJ1", brand: "DENSO" },
    { article: "90915YZZJ1", brand: "BOSCH" },
  ]);
});

test("Armtek keeps search results when optional store-name lookup fails", async () => {
  const stores = await getOptionalArmtekStoreNames(
    async () => {
      throw new SupplierIntegrationError("Store directory is unavailable");
    },
    new AbortController().signal,
  );

  assert.equal(stores.size, 0);
  assert.equal(getArmtekWarehouse({ KEYZAK: "STORE-42" }, stores), "STORE-42");
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

test("PartKOM normalizes exact official API offers", () => {
  const results = parsePartKomApiResults([
    {
      number: "VAP-021-2375",
      maker: "ВОЛГААВТОПРОМ",
      makerId: 346351,
      description: "Вал карданный",
      price: "6900,27",
      quantity: 3,
      placement: "Москва",
      expectedDate: "2026-07-28 10:30:00",
      guaranteedDate: "2026-07-29 18:00:00",
    },
    { number: "VAP-021-2375A", maker: "Brand", description: "Other", price: 100, quantity: 1 },
  ], "VAP0212375");

  assert.equal(results.length, 1);
  assert.equal(results[0].price, 6900.27);
  assert.equal(results[0].warehouse, "Москва");
  assert.equal(results[0].deliveryDateApproximate, false);
  assert.ok(results[0].deliveryDate);
  assert.ok(results[0].deliveryDateTo);
});

test("PartKOM discards a reversed delivery interval returned by the API", () => {
  const [result] = parsePartKomApiResults([{
    number: "2084001",
    maker: "FEBEST",
    makerId: 346351,
    description: "Шпилька колёсная",
    price: 176.49,
    quantity: 1,
    placement: "Н. Новгород",
    expectedDate: "2026-07-28 04:24:00",
    guaranteedDate: "2026-07-28 01:00:00",
  }], "2084-001");

  assert.ok(result.deliveryDate);
  assert.equal(result.deliveryDateTo, null);
  assert.equal(result.deliveryDateApproximate, false);
});

test("PartKOM does not treat null delivery duration as zero hours", () => {
  const [result] = parsePartKomApiResults([{
    number: "ABC-123",
    maker: "Brand",
    description: "Part",
    price: 100,
    quantity: 1,
    expectedHours: null,
    expectedDays: null,
  }], "ABC-123");

  assert.equal(result.deliveryDate, null);
  assert.equal(result.deliveryDateTo, null);
  assert.equal(result.deliveryDateApproximate, true);
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

test("delivery formatter omits an approximate marker for date ranges", () => {
  assert.equal(formatDeliveryDate("2000-07-26T00:00:00.000Z", true, "2000-07-26T12:00:00.000Z"), "~26.07.2000");
  assert.equal(formatDeliveryDate("2000-07-26T00:00:00.000Z", true, "2000-07-27T00:00:00.000Z"), "26.07.2000 - 27.07.2000");
});

test("delivery formatter names tomorrow and the day after tomorrow", () => {
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1, 12);
  const dayAfterTomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 2, 12);

  assert.equal(formatDeliveryDate(tomorrow.toISOString()), "Завтра");
  assert.equal(formatDeliveryDate(dayAfterTomorrow.toISOString()), "Послезавтра");
  assert.equal(formatDeliveryDate(tomorrow.toISOString(), false, dayAfterTomorrow.toISOString()), "Завтра - Послезавтра");
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

test("STParts session validation rejects malformed user information", async () => {
  const adapter = new StpartsApiAdapter(async () => ({}));
  const sessionManager = new SupplierSessionManager();
  sessionManager.setStpartsCredentials({ login: "test", password: "secret" });

  await assert.rejects(
    adapter.validateSession({ signal: new AbortController().signal, timeoutMs: 1000 }, sessionManager),
    /invalid user information/,
  );
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

test("PartKOM validates API credentials without running a product search", async () => {
  const calls = [];
  const adapter = new PartKomApiAdapter(async (path, params, _signal, _timeoutMs, credentials) => {
    calls.push({ path, params: params.toString(), credentials });
    return [{ id: 1, name: "Brand", country: "RU" }];
  });
  const sessionManager = new SupplierSessionManager();
  sessionManager.setPartKomCredentials({ login: "api-user", password: " secret " });

  await adapter.validateSession({ signal: new AbortController().signal, timeoutMs: 1000 }, sessionManager);

  assert.deepEqual(calls, [{
    path: "search/brands",
    params: "",
    credentials: { login: "api-user", password: " secret " },
  }]);
});

test("PartKOM connection accepts a successful non-array brands payload", async () => {
  const calls = [];
  await verifyPartKomApiCredentials({ login: "api-user", password: "secret" }, async (path, params) => {
    calls.push({ path, params: params.toString() });
    return { brands: [{ id: 1, name: "Brand" }] };
  });

  assert.deepEqual(calls, [{ path: "search/brands", params: "" }]);
});

test("PartKOM connection reports an explicit API error payload", async () => {
  await assert.rejects(
    verifyPartKomApiCredentials({ login: "api-user", password: "secret" }, async () => ({ message: "Wrong IP address" })),
    (error) => {
      assert.match(error.message, /rejected the server IP address/);
      assert.equal(error.publicMessage, "PartKOM API access is not allowed from this server IP address");
      return true;
    },
  );
});

test("PartKOM connection recognizes an IP restriction in problem JSON", async () => {
  await assert.rejects(
    verifyPartKomApiCredentials({ login: "api-user", password: "secret" }, async () => ({
      title: "Request rejected",
      detail: "Wrong IP address",
      status: 400,
    })),
    (error) => {
      assert.equal(error.publicMessage, "PartKOM API access is not allowed from this server IP address");
      return true;
    },
  );
});

test("PartKOM HTTP boundary recognizes an IP restriction before classifying status", () => {
  assert.throws(
    () => parsePartKomApiResponse({
      status: 400,
      body: JSON.stringify({ title: "Request rejected", detail: "Wrong IP address", status: 400 }),
      setCookie: [],
      contentType: "application/problem+json; charset=utf-8",
    }),
    (error) => {
      assert.equal(error.publicMessage, "PartKOM API access is not allowed from this server IP address");
      return true;
    },
  );
});

test("PartKOM HTTP boundary accepts documented JSON strings with a non-standard media type", () => {
  const brands = [{ id: 1, name: "Brand", country: "RU" }];
  assert.deepEqual(parsePartKomApiResponse({
    status: 200,
    body: JSON.stringify(brands),
    setCookie: [],
    contentType: "text/plain; charset=utf-8",
  }), brands);
});

test("PartKOM HTTP boundary accepts a BOM-prefixed JSON string", () => {
  const brands = [{ id: 1, name: "Brand", country: "RU" }];
  assert.deepEqual(parsePartKomApiResponse({
    status: 200,
    body: `\uFEFF${JSON.stringify(brands)}`,
    setCookie: [],
    contentType: "text/plain; charset=utf-8",
  }), brands);
});

test("PartKOM HTTP boundary unwraps the observed success/data envelope", () => {
  const brands = [{ id: 1, name: "Brand", country: "RU" }];
  assert.deepEqual(parsePartKomApiResponse({
    status: 200,
    body: JSON.stringify({ success: true, data: brands }),
    setCookie: [],
    contentType: "application/json",
  }), brands);
});

test("PartKOM offer normalization accepts data from the observed response envelope", () => {
  const payload = parsePartKomApiResponse({
    status: 200,
    body: JSON.stringify({
      success: true,
      data: [{
        number: "ABC-123",
        maker: "Brand",
        makerId: 42,
        description: "Part",
        price: 100,
        quantity: 1,
      }],
    }),
    setCookie: [],
    contentType: "application/json",
  });

  assert.equal(parsePartKomApiResults(payload, "ABC-123").length, 1);
});

test("PartKOM reports an unsupported successful brands payload without exposing it", async () => {
  await assert.rejects(
    verifyPartKomApiCredentials({ login: "api-user", password: "secret" }, async () => ({ unexpected: "private data" })),
    (error) => {
      assert.equal(error.publicMessage, "PartKOM API returned an unsupported brands response");
      assert.doesNotMatch(error.publicMessage, /private data/);
      assert.equal(error.diagnosticCode, "partkom_brands_object_unexpected-string");
      assert.doesNotMatch(error.diagnosticCode, /private/);
      return true;
    },
  );
});

test("PartKOM session validation reports an explicit API error payload", async () => {
  const adapter = new PartKomApiAdapter(async () => ({ message: "Wrong IP address" }));
  const sessionManager = new SupplierSessionManager();
  sessionManager.setPartKomCredentials({ login: "api-user", password: "secret" });

  await assert.rejects(
    adapter.validateSession({ signal: new AbortController().signal, timeoutMs: 1000 }, sessionManager),
    /rejected the server IP address/,
  );
});

test("PartKOM session validation rejects malformed brand data", async () => {
  const adapter = new PartKomApiAdapter(async () => ({}));
  const sessionManager = new SupplierSessionManager();
  sessionManager.setPartKomCredentials({ login: "api-user", password: "secret" });

  await assert.rejects(
    adapter.validateSession({ signal: new AbortController().signal, timeoutMs: 1000 }, sessionManager),
    /invalid brands response/,
  );
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
        isAnalog: "yes",
        link: "https://rossko.ru/invalid-analog-flag",
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

test("supplier search reports an integration error when every result is invalid", async () => {
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
        price: 100,
        warehouse: null,
        deliveryDate: null,
        deliveryDateApproximate: false,
        link: "javascript:bad",
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

  assert.deepEqual(events, [
    { type: "supplier_status", supplier: "rossko", status: "searching", details: undefined },
    { type: "supplier_status", supplier: "rossko", status: "error", details: "Supplier search failed" },
  ]);
});

test("supplier search exposes only an explicitly safe integration message", async () => {
  const sessionManager = new SupplierSessionManager();
  sessionManager.markAuthorized("armtek");
  const events = [];
  const adapter = {
    id: "armtek",
    displayName: "Armtek",
    timeoutMs: 1000,
    async ensureSession() {
      return sessionManager.getSession("armtek");
    },
    async search() {
      throw new SupplierIntegrationError("private upstream payload", {
        publicMessage: "Armtek search request failed",
      });
    },
  };

  await runSupplierSearch({
    adapter,
    sessionManager,
    query: { article: "2084001" },
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
  });

  assert.deepEqual(events, [
    { type: "supplier_status", supplier: "armtek", status: "searching", details: undefined },
    { type: "supplier_status", supplier: "armtek", status: "error", details: "Armtek search request failed" },
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

test("session manager keeps PartKOM API credentials only in runtime memory", () => {
  const sessionManager = new SupplierSessionManager();
  sessionManager.setPartKomCredentials({ login: " api-user ", password: " password " });

  assert.deepEqual(sessionManager.getPartKomCredentials(), { login: "api-user", password: " password " });
  sessionManager.clearPartKomCredentials();
  assert.equal(sessionManager.getPartKomCredentials(), null);
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
    { rossko: "Rossko", armtek: "Armtek", "part-kom": "PartKOM", stparts: "STParts", motordetal: "MotorDetal", mladov: "Механик Ладов" },
  ), [
    "PartKOM: время ожидания истекло",
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

test("server entrypoint smoke test", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "autoservice-server-test-"));
  const server = spawn(process.execPath, ["src/backend/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: "test", PORT: String(port), STATE_DIR: stateDir },
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
    await rm(stateDir, { recursive: true, force: true });
  }

  assert.equal(stderr, "");
});
