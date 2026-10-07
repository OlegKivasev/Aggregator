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
    set: () => {},
  });
  assert.throws(() => service.saveApiKey("test-key"), SupplierIntegrationError);
});
