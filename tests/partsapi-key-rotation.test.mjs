import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApplicabilityApplicationService } from "../src/backend/applicability/applicability-application-service.ts";
import { EncryptedApplicabilityApiKeyStore } from "../src/backend/applicability/encrypted-api-key-store.ts";
import { PartsApiApplicabilityClient } from "../src/backend/applicability/partsapi-client.ts";
import { PartsApiKeyError } from "../src/backend/applicability/partsapi-key-error.ts";
import { SqliteApplicabilityCacheRepository } from "../src/backend/applicability/sqlite-applicability-cache-repository.ts";
import { SupplierAuthError, SupplierTimeoutError } from "../src/backend/errors.ts";

// Fictional credentials and supplier results, isolated from production composition.
const primary = "fictional-primary-AAAAA";
const first = "fictional-fallback-BBBBB";
const second = "fictional-fallback-CCCCC";
const day = 24 * 60 * 60 * 1000;
const quotaPayload = { error_code: 5000, message: "Exceeded the number of requests from the current IP address.", status: 401 };
const vehicle = { carId: 1, carName: "Test", carType: "PC", makeName: "FORD", modelName: "Test", yearEnd: null, yearStart: null };
const query = { sku: "OEM1", brand: "FORD" };
const signal = () => new AbortController().signal;
const limitedResponse = () => Response.json(quotaPayload, { status: 401 });

function fixture(t, request) {
  const directory = mkdtempSync(join(tmpdir(), "partsapi-rotation-"));
  const filePath = join(directory, "keys.enc.json");
  const encryptionKey = Buffer.alloc(32, 9);
  const clock = { now: 1_800_000_000_000 };
  const store = new EncryptedApplicabilityApiKeyStore(filePath, encryptionKey, () => clock.now);
  const cache = new SqliteApplicabilityCacheRepository(join(directory, "cache.sqlite"));
  t.after(() => { cache.close(); rmSync(directory, { recursive: true, force: true }); });
  const service = new ApplicabilityApplicationService(new PartsApiApplicabilityClient(request), store, cache);
  return { directory, filePath, encryptionKey, clock, store, cache, service };
}

test("PartsAPI retries the same search in saved key order and retains encrypted active/limited state", async (t) => {
  const requests = [];
  const { service, store, filePath, encryptionKey, clock } = fixture(t, async (url) => {
    requests.push({ key: url.searchParams.get("key"), sku: url.searchParams.get("sku") });
    return url.searchParams.get("key") === second ? Response.json([vehicle]) : limitedResponse();
  });
  store.set(primary);
  store.addFallbackKey(first);
  store.addFallbackKey(second);
  assert.deepEqual(await service.search(query, signal()), { results: [vehicle], cacheHit: false });
  assert.deepEqual(requests, [primary, first, second].map((key) => ({ key, sku: "OEM1" })));
  const state = service.getApiKeyState();
  assert.deepEqual(state.primaryKey, { maskedKey: "…AAAAA", limited: true, active: false, resetAt: clock.now + day, requestCount: 1 });
  assert.deepEqual(state.fallbackKeys.map((key) => key.requestCount), [1, 1]);
  assert.deepEqual(state.fallbackKeys.map(({ limited, active }) => ({ limited, active })), [{ limited: true, active: false }, { limited: false, active: true }]);
  assert.equal(store.get(), primary, "original field is retained in place");
  assert.equal(new EncryptedApplicabilityApiKeyStore(filePath, encryptionKey, () => clock.now).getActiveKey(), second);
  for (const key of [primary, first, second]) {
    assert.ok(!JSON.stringify(state).includes(key));
    assert.ok(!readFileSync(filePath, "utf8").includes(key));
  }
  assert.deepEqual(await service.search(query, signal()), { results: [vehicle], cacheHit: true });
  assert.equal(requests.length, 3, "cached searches use no key");
  assert.equal(store.getState().fallbackKeys[1].requestCount, 1);
  await service.search({ ...query, sku: "OEM2" }, signal());
  assert.equal(requests.at(-1).key, second);
  assert.equal(store.getState().fallbackKeys[1].requestCount, 2);
});

test("parallel quota failures of one key switch once and do not skip healthy fallbacks", async (t) => {
  const primaryRequests = [];
  const requests = [];
  const { service, store } = fixture(t, (url) => {
    const key = url.searchParams.get("key");
    requests.push(key);
    if (key === primary) return new Promise((resolve) => primaryRequests.push(resolve));
    return Promise.resolve(Response.json([vehicle]));
  });
  store.set(primary);
  store.addFallbackKey(first);
  store.addFallbackKey(second);
  const pending = [1, 2, 3, 4].map((id) => service.search({ ...query, sku: `OEM${id}` }, signal()));
  assert.equal(primaryRequests.length, 4);
  primaryRequests.forEach((resolve) => resolve(limitedResponse()));
  assert.equal((await Promise.all(pending)).length, 4);
  assert.deepEqual(requests, [...Array(4).fill(primary), ...Array(4).fill(first)]);
  assert.equal(store.getState().fallbackKeys[0].active, true);
  assert.equal(store.getState().fallbackKeys[1].limited, false);
  assert.equal(store.getState().primaryKey.requestCount, 4);
  assert.deepEqual(store.getState().fallbackKeys.map((key) => key.requestCount), [4, 0]);
});

test("all keys are attempted once, remain blocked across restart and become eligible at the 24-hour boundary", async (t) => {
  const requests = [];
  const { service, store, clock, filePath, encryptionKey } = fixture(t, async (url) => {
    requests.push(url.searchParams.get("key"));
    return limitedResponse();
  });
  store.set(primary);
  store.addFallbackKey(first);
  store.addFallbackKey(primary); // Duplicated settings must not repeat the same credential.
  await assert.rejects(service.search(query, signal()), PartsApiKeyError);
  assert.deepEqual(requests, [primary, first]);
  assert.equal(store.getActiveKey(), null);
  clock.now += day - 1;
  const restored = new EncryptedApplicabilityApiKeyStore(filePath, encryptionKey, () => clock.now);
  assert.equal(restored.getActiveKey(), null);
  await assert.rejects(service.search(query, signal()), (error) => /всех сохранённых/.test(error.publicMessage));
  assert.equal(requests.length, 2);
  clock.now += 1;
  assert.equal(restored.getActiveKey(), primary);
  assert.equal(restored.getState().primaryKey.limited, false);
  await assert.rejects(service.search(query, signal()), PartsApiKeyError);
  assert.deepEqual(requests, [primary, first, primary, first]);
});

test("quota windows and counters start on the first upstream request, persist and do not slide on later or cached requests", async (t) => {
  let rejectPrimary = false;
  const { service, store, clock, filePath, encryptionKey } = fixture(t, async (url) =>
    rejectPrimary && url.searchParams.get("key") === primary ? limitedResponse() : Response.json([vehicle]));
  store.set(primary);
  store.addFallbackKey(first);
  const startedAt = clock.now;
  await service.search(query, signal());
  clock.now += 60 * 60 * 1000;
  await service.search({ ...query, sku: "OEM2" }, signal());
  await service.search(query, signal());
  assert.equal(store.getState().primaryKey.resetAt, startedAt + day);
  assert.equal(store.getState().primaryKey.requestCount, 2);
  rejectPrimary = true;
  await service.search({ ...query, sku: "OEM3" }, signal());
  assert.equal(store.getState().primaryKey.resetAt, startedAt + day);
  assert.equal(store.getState().fallbackKeys[0].resetAt, clock.now + day);
  assert.equal(store.getState().primaryKey.requestCount, 3);
  const restored = new EncryptedApplicabilityApiKeyStore(filePath, encryptionKey, () => clock.now);
  clock.now = startedAt + day;
  assert.equal(restored.getState().primaryKey.limited, false);
  assert.equal(restored.getState().primaryKey.resetAt, null);
  assert.equal(restored.getState().primaryKey.requestCount, 0);
  assert.equal(restored.getState().fallbackKeys[0].requestCount, 1);
  assert.equal(restored.getActiveKey(), first, "working active key keeps priority when another key resets");
  restored.markLimited(first);
  assert.equal(restored.getActiveKey(), primary);
  restored.recordRequest(primary);
  assert.equal(restored.getState().primaryKey.resetAt, clock.now + day);
  assert.equal(restored.getState().primaryKey.requestCount, 1);
});

test("ordinary authorization failures do not rotate or mark keys limited", async (t) => {
  const requests = [];
  const { store, service } = fixture(t, async (url) => {
    requests.push(url.searchParams.get("key"));
    return Response.json({ error_code: 5000, message: "Invalid key" }, { status: 401 });
  });
  store.set(primary);
  store.addFallbackKey(first);
  await assert.rejects(service.search(query, signal()), (error) => error instanceof PartsApiKeyError && !error.limitExceeded);
  assert.deepEqual(requests, [primary]);
  assert.equal(store.getState().primaryKey.limited, false);
  assert.equal(store.getState().primaryKey.requestCount, 1, "rejected upstream requests are counted too");
  assert.equal(store.getActiveKey(), primary);
});

test("saved fallback works without the original key and missing configuration makes no upstream request", async (t) => {
  let calls = 0;
  const { store, service } = fixture(t, async () => { calls += 1; return Response.json([vehicle]); });
  await assert.rejects(service.search(query, signal()), SupplierAuthError);
  assert.equal(calls, 0);
  store.addFallbackKey(first);
  assert.equal(store.getState().configured, true);
  await service.search(query, signal());
  assert.equal(calls, 1);
  store.set(primary);
  store.markLimited(primary);
  store.set(primary);
  assert.equal(store.getState().primaryKey.limited, true, "saving the same credential cannot reset its quota");
});

test("abort during a rejected request stops rotation and does not change quota or cache state", async (t) => {
  const controller = new AbortController();
  const { store, service, cache } = fixture(t, async () => { controller.abort(); return limitedResponse(); });
  store.set(primary);
  store.addFallbackKey(first);
  await assert.rejects(service.search(query, controller.signal), { name: "AbortError" });
  assert.equal(store.getState().primaryKey.limited, false);
  assert.equal(cache.get(query), null);
});

test("late failure cannot restore a deleted key or corrupt the next active slot", async (t) => {
  let finish;
  const { store, service } = fixture(t, (url) => url.searchParams.get("key") === primary
    ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(Response.json([vehicle])));
  store.set(primary);
  store.addFallbackKey(first);
  store.addFallbackKey(second);
  const pending = service.search(query, signal());
  store.delete();
  finish(limitedResponse());
  await pending;
  assert.equal(store.getState().primaryKey, null);
  assert.equal(store.getActiveKey(), first);
  store.deleteFallbackKey(0);
  assert.equal(store.getActiveKey(), second);
  assert.equal(store.getState().fallbackKeys[0].active, true);
});

test("rotation has a total timeout and cannot write results after it expires", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { store, cache, service } = fixture(t, (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }));
  store.set(primary);
  const pending = service.search(query, signal());
  t.mock.timers.tick(30_000);
  await assert.rejects(pending, SupplierTimeoutError);
  assert.equal(cache.get(query), null);
  assert.equal(store.getState().primaryKey.limited, false);
});

function writeLegacyStore(filePath, encryptionKey, payload) {
  const iv = Buffer.alloc(12, 3);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  cipher.setAAD(Buffer.from("autoservice-aggregator:partsapi-key:v1"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  writeFileSync(filePath, JSON.stringify({ version: 1, algorithm: "aes-256-gcm", iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), authTag: cipher.getAuthTag().toString("base64") }));
}

test("encrypted v1/v2 stores migrate without losing keys and invalid v3 state is rejected", (t) => {
  const { filePath, encryptionKey } = fixture(t);
  for (const payload of [{ version: 1, apiKey: primary }, { version: 2, apiKey: primary, fallbackApiKeys: [first] }, { version: 2, apiKey: null, fallbackApiKeys: [first] }]) {
    writeLegacyStore(filePath, encryptionKey, payload);
    const store = new EncryptedApplicabilityApiKeyStore(filePath, encryptionKey);
    assert.equal(store.get(), payload.apiKey);
    assert.equal(store.getActiveKey(), payload.apiKey ?? first);
    assert.equal(store.getState().fallbackKeyCount, payload.fallbackApiKeys?.length ?? 0);
  }
  for (const invalid of [undefined, -1, "date", Infinity]) {
    writeLegacyStore(filePath, encryptionKey, { version: 3, primaryKey: { apiKey: primary, firstRequestAt: invalid, limited: true, requestCount: 0 }, fallbackKeys: [], activeKeyIndex: 0 });
    assert.throws(() => new EncryptedApplicabilityApiKeyStore(filePath, encryptionKey), /invalid key state/);
  }
});

test("failed persistence rolls back active and quota state", (t) => {
  const { store, filePath } = fixture(t);
  store.set(primary);
  store.addFallbackKey(first);
  const previous = store.getState();
  rmSync(filePath);
  mkdirSync(filePath);
  assert.throws(() => store.markLimited(primary));
  assert.deepEqual(store.getState(), previous);
  assert.equal(store.getActiveKey(), primary);
});

test("manual activation changes the next search key, persists and keeps each key's counter and reset time", async (t) => {
  const requests = [];
  const { store, service, filePath, encryptionKey, clock } = fixture(t, async (url) => {
    requests.push(url.searchParams.get("key"));
    return Response.json([vehicle]);
  });
  store.set(primary);
  store.addFallbackKey(first);
  store.addFallbackKey(second);
  await service.search(query, signal());
  const original = store.getState().primaryKey;
  const state = service.selectActiveApiKey(2);
  assert.equal(state.fallbackKeys[1].active, true);
  assert.equal(state.primaryKey.requestCount, original.requestCount);
  await service.search({ ...query, sku: "OEM2" }, signal());
  assert.deepEqual(requests, [primary, second]);
  assert.equal(new EncryptedApplicabilityApiKeyStore(filePath, encryptionKey, () => clock.now).getActiveKey(), second);
  service.selectActiveApiKey(0);
  assert.deepEqual(store.getState().primaryKey, original);
  store.markLimited(primary);
  assert.throws(() => service.selectActiveApiKey(0), PartsApiKeyError);
  assert.throws(() => service.selectActiveApiKey(99), /does not exist/);
  assert.throws(() => service.selectActiveApiKey(-1), /does not exist/);
  assert.equal(store.getState().primaryKey.requestCount, 1);
});
