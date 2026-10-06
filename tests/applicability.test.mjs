import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApplicabilityApplicationService } from "../src/backend/applicability/applicability-application-service.ts";
import { EncryptedApplicabilityApiKeyStore } from "../src/backend/applicability/encrypted-api-key-store.ts";
import { SupplierAuthError, SupplierIntegrationError } from "../src/backend/errors.ts";
import { PartsApiApplicabilityClient } from "../src/backend/applicability/partsapi-client.ts";

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
    assert.equal(store.isPersistent(), true);

    const restoredStore = new EncryptedApplicabilityApiKeyStore(filePath, encryptionKey);
    assert.equal(restoredStore.get(), "test-key");
    restoredStore.delete();
    assert.equal(restoredStore.get(), null);
    assert.equal(new EncryptedApplicabilityApiKeyStore(filePath, encryptionKey).get(), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("applicability service keeps the API key out of the search request boundary", async () => {
  let savedKey = null;
  let receivedQuery = null;
  const repository = {
    get: () => savedKey,
    set: (apiKey) => { savedKey = apiKey; },
    delete: () => { savedKey = null; },
    isPersistent: () => true,
  };
  const service = new ApplicabilityApplicationService({
    search: async (query) => {
      receivedQuery = query;
      return [];
    },
  }, repository);

  assert.deepEqual(service.getApiKeyState(), { configured: false, persistent: true });
  service.saveApiKey("test-key");
  await service.search({ sku: "11182905003", brand: "LADA" }, new AbortController().signal);
  assert.deepEqual(receivedQuery, { sku: "11182905003", brand: "LADA", apiKey: "test-key" });
  assert.deepEqual(service.deleteApiKey(), { configured: false, persistent: true });
});

test("applicability service refuses to save an API key without encrypted persistence", () => {
  const repository = {
    get: () => null,
    set: () => { throw new Error("must not save"); },
    delete: () => {},
    isPersistent: () => false,
  };
  const service = new ApplicabilityApplicationService({ search: async () => [] }, repository);
  assert.throws(() => service.saveApiKey("test-key"), SupplierIntegrationError);
});
