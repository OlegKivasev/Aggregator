import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApplicabilityApplicationService } from "../src/backend/applicability/applicability-application-service.ts";
import { EncryptedApplicabilityApiKeyStore } from "../src/backend/applicability/encrypted-api-key-store.ts";
import { SupplierAuthError, SupplierIntegrationError } from "../src/backend/errors.ts";
import { PartsApiApplicabilityClient } from "../src/backend/applicability/partsapi-client.ts";
import { SqliteApplicabilityCacheRepository } from "../src/backend/applicability/sqlite-applicability-cache-repository.ts";
import { DatabaseSync } from "node:sqlite";

const vehicle = {
  carId: 31251,
  carName: "1.4 16V",
  carType: "PC",
  makeName: "LADA",
  modelName: "KALINA Saloon (1118)",
  yearEnd: "12.2013",
  yearStart: "09.2006",
};

test("PartsAPI applicability client uses the documented endpoint and validates records", async () => {
  let requestedUrl;
  const client = new PartsApiApplicabilityClient(async (url) => {
    requestedUrl = url;
    return new Response(JSON.stringify([vehicle]), { headers: { "Content-Type": "application/json" } });
  });

  const results = await client.search({ sku: "11182905003", brand: "LADA", apiKey: "test-key" }, new AbortController().signal);

  assert.equal(requestedUrl.origin, "https://api.partsapi.ru");
  assert.equal(requestedUrl.searchParams.get("method"), "getApplicability");
  assert.equal(requestedUrl.searchParams.get("sku"), "11182905003");
  assert.equal(requestedUrl.searchParams.get("brand"), "LADA");
  assert.equal(requestedUrl.searchParams.get("key"), "test-key");
  assert.deepEqual(results, [vehicle]);
});

test("PartsAPI applicability client accepts nullable optional vehicle fields", async () => {
  const nullableVehicle = {
    ...vehicle,
    carName: null,
    carType: null,
    makeName: null,
    modelName: null,
    yearEnd: null,
    yearStart: null,
  };
  const client = new PartsApiApplicabilityClient(async () => new Response(JSON.stringify([nullableVehicle]), {
    headers: { "Content-Type": "application/json" },
  }));

  const results = await client.search(
    { sku: "11182905003", brand: "LADA", apiKey: "test-key" },
    new AbortController().signal,
  );

  assert.deepEqual(results, [nullableVehicle]);
});

test("PartsAPI applicability client rejects malformed data and rejected API keys", async () => {
  const malformedClient = new PartsApiApplicabilityClient(async () => new Response(JSON.stringify([{ ...vehicle, carId: "31251" }]), {
    headers: { "Content-Type": "application/json" },
  }));
  await assert.rejects(
    malformedClient.search({ sku: "11182905003", brand: "LADA", apiKey: "test-key" }, new AbortController().signal),
    SupplierIntegrationError,
  );

  const rejectedClient = new PartsApiApplicabilityClient(async () => new Response(null, { status: 403 }));
  await assert.rejects(
    rejectedClient.search({ sku: "11182905003", brand: "LADA", apiKey: "test-key" }, new AbortController().signal),
    SupplierAuthError,
  );
});

test("PartsAPI key is stored encrypted and can only be removed explicitly", () => {
  const directory = mkdtempSync(join(tmpdir(), "partsapi-key-"));
  const filePath = join(directory, "partsapi-key.enc.json");
  const encryptionKey = Buffer.alloc(32, 7);
  try {
    const store = new EncryptedApplicabilityApiKeyStore(filePath, encryptionKey);
    store.set("test-key");
    assert.equal(store.get(), "test-key");
    assert.equal(store.getFallbackKeyCount(), 0);
    store.addFallbackKey("first-fallback-key");
    store.addFallbackKey("second-fallback-key");
    assert.equal(store.getFallbackKeyCount(), 2);
    assert.equal(store.isPersistent(), true);

    const restoredStore = new EncryptedApplicabilityApiKeyStore(filePath, encryptionKey);
    assert.equal(restoredStore.get(), "test-key");
    assert.equal(restoredStore.getFallbackKeyCount(), 2);
    restoredStore.delete();
    assert.equal(restoredStore.get(), null);
    assert.equal(restoredStore.getFallbackKeyCount(), 2);
    restoredStore.deleteFallbackKey(0);
    assert.equal(restoredStore.getFallbackKeyCount(), 1);
    const storeWithOnlyFallbackKey = new EncryptedApplicabilityApiKeyStore(filePath, encryptionKey);
    assert.equal(storeWithOnlyFallbackKey.get(), null);
    assert.equal(storeWithOnlyFallbackKey.getFallbackKeyCount(), 1);
    storeWithOnlyFallbackKey.deleteFallbackKey(0);
    assert.equal(new EncryptedApplicabilityApiKeyStore(filePath, encryptionKey).get(), null);
    assert.equal(new EncryptedApplicabilityApiKeyStore(filePath, encryptionKey).getFallbackKeyCount(), 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("applicability cache persists real PartsAPI responses", () => {
  const directory = mkdtempSync(join(tmpdir(), "partsapi-cache-"));
  const filePath = join(directory, "cache.sqlite");
  try {
    const cache = new SqliteApplicabilityCacheRepository(filePath);
    cache.set({ sku: "11182905003", brand: "LADA" }, [vehicle]);
    cache.set({ sku: "21702915004", brand: "LADA" }, [vehicle]);
    cache.close();

    const restoredCache = new SqliteApplicabilityCacheRepository(filePath);
    assert.deepEqual(restoredCache.get({ sku: "11182905003", brand: "LADA" }), [vehicle]);
    assert.deepEqual(restoredCache.findBrands("2170-2915004"), ["LADA"]);
    restoredCache.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("applicability service returns cached results without repeating the PartsAPI request", async () => {
  let savedKey = null;
  const fallbackKeys = [];
  let receivedQuery = null;
  let calls = 0;
  const entries = new Map();
  const repository = {
    get: () => savedKey,
    set: (apiKey) => { savedKey = apiKey; },
    delete: () => { savedKey = null; },
    getFallbackKeyCount: () => fallbackKeys.length,
    addFallbackKey: (apiKey) => { fallbackKeys.push(apiKey); },
    deleteFallbackKey: (index) => { fallbackKeys.splice(index, 1); },
    isPersistent: () => true,
  };
  const service = new ApplicabilityApplicationService({
    search: async (query) => {
      calls += 1;
      receivedQuery = query;
      return [vehicle];
    },
  }, repository, {
    get: (query) => entries.get(`${query.sku}\u0000${query.brand}`) ?? null,
    findBrands: () => [],
    list: () => ({ articles: [], brandCounts: [], hasMore: false }),
    delete: () => false,
    set: (query, results) => entries.set(`${query.sku}\u0000${query.brand}`, results),
  });

  assert.deepEqual(service.getApiKeyState(), { configured: false, fallbackKeyCount: 0, persistent: true });
  service.saveApiKey("test-key");
  assert.deepEqual(service.addFallbackApiKey("fallback-key"), { configured: true, fallbackKeyCount: 1, persistent: true });
  assert.deepEqual(
    await service.search({ sku: "11182905003", brand: "LADA" }, new AbortController().signal),
    { results: [vehicle], cacheHit: false },
  );
  assert.deepEqual(
    await service.search({ sku: "11182905003", brand: "LADA" }, new AbortController().signal),
    { results: [vehicle], cacheHit: true },
  );
  assert.deepEqual(receivedQuery, { sku: "11182905003", brand: "LADA", apiKey: "test-key" });
  assert.equal(calls, 1);
  assert.deepEqual(service.deleteFallbackApiKey(0), { configured: true, fallbackKeyCount: 0, persistent: true });
  assert.deepEqual(service.deleteApiKey(), { configured: false, fallbackKeyCount: 0, persistent: true });
});

test("applicability service refuses to save an API key without encrypted persistence", () => {
  const repository = {
    get: () => null,
    set: () => { throw new Error("must not save"); },
    delete: () => {},
    getFallbackKeyCount: () => 0,
    addFallbackKey: () => { throw new Error("must not save"); },
    deleteFallbackKey: () => {},
    isPersistent: () => false,
  };
  const service = new ApplicabilityApplicationService({ search: async () => [] }, repository, {
    get: () => null,
    findBrands: () => [],
    list: () => ({ articles: [], brandCounts: [], hasMore: false }),
    delete: () => false,
    set: () => {},
  });
  assert.throws(() => service.saveApiKey("test-key"), SupplierIntegrationError);
});

test("saved OEM library pages, searches, reads and deletes only the selected article and brand", () => {
  const directory = mkdtempSync(join(tmpdir(), "partsapi-library-"));
  const filePath = join(directory, "cache.sqlite");
  const cache = new SqliteApplicabilityCacheRepository(filePath);
  try {
    cache.set({ sku: "SKU", brand: "VOLVO" }, [vehicle]);
    cache.set({ sku: "SKU", brand: "LADA" }, []);
    for (let index = 0; index < 103; index += 1) cache.set({ sku: `TEST${String(index).padStart(3, "0")}`, brand: "VOLVO" }, [vehicle]);
    const first = cache.list({ search: "", offset: 0, order: "brand", includeNotFound: true });
    assert.equal(first.articles.length, 100);
    assert.equal(first.hasMore, true);
    assert.deepEqual(first.articles[0], { sku: "SKU", brand: "LADA", hasResults: false });
    assert.deepEqual(first.brandCounts, [{ brand: "LADA", found: 0, notFound: 1 }, { brand: "VOLVO", found: 104, notFound: 0 }]);
    const second = cache.list({ search: "", offset: 100, order: "brand", includeNotFound: true });
    assert.equal(second.articles.length, 5);
    assert.equal(second.hasMore, false);
    assert.deepEqual(second.brandCounts, first.brandCounts);
    assert.equal(new Set([...first.articles, ...second.articles].map((article) => JSON.stringify(article))).size, 105);
    assert.deepEqual(cache.list({ search: "sku", offset: 0, order: "sku", includeNotFound: true }).articles,
      [{ sku: "SKU", brand: "LADA", hasResults: false }, { sku: "SKU", brand: "VOLVO", hasResults: true }]);
    assert.deepEqual(cache.list({ search: "lada", offset: 0, order: "brand", includeNotFound: true }).articles, [{ sku: "SKU", brand: "LADA", hasResults: false }]);
    assert.deepEqual(cache.list({ search: "%' OR 1=1", offset: 0, order: "sku", includeNotFound: true }), { articles: [], brandCounts: [], hasMore: false });
    assert.equal(cache.delete({ sku: "sku", brand: "volvo" }), true);
    assert.equal(cache.delete({ sku: "SKU", brand: "VOLVO" }), false);
    assert.equal(cache.get({ sku: "SKU", brand: "VOLVO" }), null);
    assert.deepEqual(cache.list({ search: "sku", offset: 0, order: "brand", includeNotFound: true }).brandCounts, [{ brand: "LADA", found: 0, notFound: 1 }]);
    assert.deepEqual(cache.get({ sku: "SKU", brand: "LADA" }), []);
    assert.equal(cache.list({ search: "", offset: 0, order: "sku", includeNotFound: true }).hasMore, true);
    const database = new DatabaseSync(filePath);
    try {
      database.prepare("UPDATE applicability_search_cache SET results_json = ? WHERE sku = ? AND brand = ?").run('{"invalid":true}', "SKU", "LADA");
      assert.equal(cache.get({ sku: "SKU", brand: "LADA" }), null);
    } finally { database.close(); }
  } finally {
    cache.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("saved OEM list filters empty results before paging and keeps them available on request", () => {
  const directory = mkdtempSync(join(tmpdir(), "partsapi-library-filter-"));
  const filePath = join(directory, "cache.sqlite");
  const cache = new SqliteApplicabilityCacheRepository(filePath);
  try {
    for (let index = 0; index < 103; index += 1) {
      cache.set({ sku: `EMPTY${index}`, brand: "LADA" }, []);
      cache.set({ sku: `FOUND${String(index).padStart(3, "0")}`, brand: "VOLVO" }, [vehicle]);
    }
    const query = { search: "", offset: 0, order: "brand", includeNotFound: false };
    const first = cache.list(query);
    assert.equal(first.articles.length, 100);
    assert.equal(first.hasMore, true);
    assert.ok(first.articles.every((article) => article.brand === "VOLVO"));
    assert.ok(first.articles.every((article) => article.hasResults));
    assert.deepEqual(first.brandCounts, [{ brand: "VOLVO", found: 103, notFound: 0 }]);
    assert.deepEqual(cache.list({ ...query, offset: 100 }), {
      articles: [100, 101, 102].map((index) => ({ sku: `FOUND${index}`, brand: "VOLVO", hasResults: true })),
      brandCounts: first.brandCounts, hasMore: false,
    });
    assert.deepEqual(cache.list({ ...query, search: "EMPTY", order: "sku" }), { articles: [], brandCounts: [], hasMore: false });
    assert.equal(cache.list({ ...query, search: "LADA", includeNotFound: true }).articles.length, 100);
    assert.deepEqual(cache.get({ sku: "EMPTY0", brand: "LADA" }), []);
    const database = new DatabaseSync(filePath);
    try {
      database.prepare("UPDATE applicability_search_cache SET results_json = ? WHERE sku = ? AND brand = ?").run("invalid", "EMPTY0", "LADA");
      assert.deepEqual(cache.list({ ...query, search: "EMPTY0" }), { articles: [], brandCounts: [], hasMore: false });
      assert.deepEqual(cache.list({ ...query, search: "EMPTY0", includeNotFound: true }).brandCounts, [{ brand: "LADA", found: 0, notFound: 1 }]);
    } finally { database.close(); }
  } finally {
    cache.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("saved brand counters count articles, respect search and refresh after deletion", () => {
  const directory = mkdtempSync(join(tmpdir(), "partsapi-brand-counts-"));
  const cache = new SqliteApplicabilityCacheRepository(join(directory, "cache.sqlite"));
  try {
    cache.set({ sku: "MATCH1", brand: "VOLVO" }, [vehicle, { ...vehicle, carId: 2 }]);
    cache.set({ sku: "MATCH2", brand: "VOLVO" }, []);
    cache.set({ sku: "OTHER", brand: "VOLVO" }, [vehicle]);
    cache.set({ sku: "MATCH1", brand: "LADA" }, []);
    const query = { search: "MATCH", offset: 0, order: "brand", includeNotFound: true };
    assert.deepEqual(cache.list(query).brandCounts, [{ brand: "LADA", found: 0, notFound: 1 }, { brand: "VOLVO", found: 1, notFound: 1 }]);
    assert.deepEqual(cache.list({ ...query, search: "VOLVO" }).brandCounts, [{ brand: "VOLVO", found: 2, notFound: 1 }]);
    assert.deepEqual(cache.list({ ...query, includeNotFound: false }).brandCounts, [{ brand: "VOLVO", found: 1, notFound: 1 }]);
    cache.delete({ sku: "MATCH2", brand: "VOLVO" });
    assert.deepEqual(cache.list(query).brandCounts, [{ brand: "LADA", found: 0, notFound: 1 }, { brand: "VOLVO", found: 1, notFound: 0 }]);
  } finally {
    cache.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("saved OEM results are accessible without an API key and deletion persists after reopening", () => {
  const directory = mkdtempSync(join(tmpdir(), "partsapi-library-service-"));
  const path = join(directory, "cache.sqlite");
  let cache = new SqliteApplicabilityCacheRepository(path);
  const keyRepository = { get: () => null };
  try {
    cache.set({ sku: "SKU", brand: "VOLVO" }, [vehicle]);
    const service = new ApplicabilityApplicationService({ search: async () => { throw new Error("must not call PartsAPI"); } }, keyRepository, cache);
    assert.deepEqual(service.getSavedArticle({ sku: "SKU", brand: "VOLVO" }), [vehicle]);
    assert.deepEqual(service.listSavedArticles({ search: "", offset: 0, order: "sku", includeNotFound: false }), {
      articles: [{ sku: "SKU", brand: "VOLVO", hasResults: true }], brandCounts: [{ brand: "VOLVO", found: 1, notFound: 0 }], hasMore: false,
    });
    assert.equal(service.deleteSavedArticle({ sku: "SKU", brand: "VOLVO" }), true);
    cache.close();
    cache = new SqliteApplicabilityCacheRepository(path);
    assert.equal(cache.get({ sku: "SKU", brand: "VOLVO" }), null);
  } finally {
    cache.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("deletion prevents a late applicability search from restoring the deleted OEM pair", async () => {
  let finish;
  let written = false;
  const service = new ApplicabilityApplicationService({ search: () => new Promise((resolve) => { finish = resolve; }) },
    { get: () => "test-key" }, { get: () => null, set: () => { written = true; }, delete: () => false });
  const query = { sku: "SKU", brand: "VOLVO" };
  const pending = service.search(query, new AbortController().signal);
  assert.equal(service.deleteSavedArticle({ sku: "sku", brand: "volvo" }), false);
  finish([vehicle]);
  await assert.rejects(pending, SupplierIntegrationError);
  assert.equal(written, false);
});

test("an aborted applicability lookup cannot write saved OEM results", async () => {
  const controller = new AbortController();
  let written = false;
  const service = new ApplicabilityApplicationService({ search: async () => { controller.abort(); return [vehicle]; } },
    { get: () => "test-key" }, { get: () => null, set: () => { written = true; } });
  await assert.rejects(service.search({ sku: "SKU", brand: "VOLVO" }, controller.signal), { name: "AbortError" });
  assert.equal(written, false);
});
