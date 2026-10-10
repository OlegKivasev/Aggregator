import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const standby = "fictional-standby-BBBBB";
const replacement = "fictional-replacement-CCCCC";
const quotaPayload = { error_code: 5000, message: "Exceeded the number of requests from the current IP address.", status: 401 };
const vehicle = { carId: 1, carName: "Test", carType: "PC", makeName: "FORD", modelName: "Test", yearEnd: null, yearStart: null };
const query = { sku: "OEM1", brand: "FORD" };
const signal = () => new AbortController().signal;
const context = Buffer.from("autoservice-aggregator:partsapi-key:v1");

function fixture(t, request) {
  const directory = mkdtempSync(join(tmpdir(), "partsapi-single-"));
  const filePath = join(directory, "keys.enc.json");
  const encryptionKey = Buffer.alloc(32, 9);
  const store = new EncryptedApplicabilityApiKeyStore(filePath, encryptionKey);
  const cache = new SqliteApplicabilityCacheRepository(join(directory, "cache.sqlite"));
  t.after(() => { cache.close(); rmSync(directory, { recursive: true, force: true }); });
  const service = new ApplicabilityApplicationService(new PartsApiApplicabilityClient(request), store, cache);
  return { filePath, encryptionKey, store, cache, service };
}

function writeEncryptedStore(filePath, encryptionKey, payload) {
  const iv = Buffer.alloc(12, 3);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  cipher.setAAD(context);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  writeFileSync(filePath, JSON.stringify({ version: 1, algorithm: "aes-256-gcm", iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), authTag: cipher.getAuthTag().toString("base64") }));
}

function readEncryptedPayload(filePath, encryptionKey) {
  const envelope = JSON.parse(readFileSync(filePath, "utf8"));
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(envelope.iv, "base64"));
  decipher.setAAD(context);
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8"));
}

const oldKey = (apiKey) => ({ apiKey, firstRequestAt: 1_800_000_000_000, limited: true, requestCount: 99 });

test("encrypted stores retain one selected credential and discard standby keys and quota state on save", (t) => {
  const { filePath, encryptionKey } = fixture(t);
  const cases = [
    [{ version: 1, apiKey: primary }, primary],
    [{ version: 1, apiKey: null }, null],
    [{ version: 2, apiKey: primary, fallbackApiKeys: [standby] }, primary],
    [{ version: 2, apiKey: null, fallbackApiKeys: [standby] }, standby],
    [{ version: 3, primaryKey: oldKey(primary), fallbackKeys: [oldKey(standby)], activeKeyIndex: 1 }, standby],
    [{ version: 3, primaryKey: oldKey(primary), fallbackKeys: [oldKey(standby)], activeKeyIndex: null }, primary],
    [{ version: 3, primaryKey: null, fallbackKeys: [oldKey(standby)], activeKeyIndex: null }, standby],
    [{ version: 3, primaryKey: null, fallbackKeys: [], activeKeyIndex: null }, null],
    [{ version: 1, apiKey: replacement }, replacement],
  ];
  for (const [payload, retained] of cases) {
    writeEncryptedStore(filePath, encryptionKey, payload);
    const originalFile = readFileSync(filePath);
    const store = new EncryptedApplicabilityApiKeyStore(filePath, encryptionKey);
    assert.equal(store.get(), retained);
    assert.deepEqual(store.getState(), { configured: retained !== null, persistent: true, maskedKey: retained ? `…${retained.slice(-5)}` : null });
    assert.deepEqual(readFileSync(filePath), originalFile, "loading must not rewrite existing credentials");
    store.set(replacement);
    assert.deepEqual(readEncryptedPayload(filePath, encryptionKey), { version: 1, apiKey: replacement });
    assert.ok(!readFileSync(filePath, "utf8").includes(replacement));
    assert.equal(new EncryptedApplicabilityApiKeyStore(filePath, encryptionKey).get(), replacement);
    store.delete();
    assert.equal(existsSync(filePath), false);
    assert.equal(store.get(), null);
  }
});

test("invalid encrypted key formats and tampered ciphertext are rejected", (t) => {
  const { filePath, encryptionKey } = fixture(t);
  for (const payload of [
    { version: 1, apiKey: "" }, { version: 1, apiKey: 123 }, { version: 5, apiKey: primary },
    { version: 2, apiKey: primary, fallbackApiKeys: [null] },
    { version: 3, primaryKey: oldKey(primary), fallbackKeys: [oldKey(standby)], activeKeyIndex: 99 },
    { version: 3, primaryKey: null, fallbackKeys: [], activeKeyIndex: 0 },
    { version: 3, primaryKey: oldKey(primary), fallbackKeys: [{ apiKey: null }], activeKeyIndex: 0 },
  ]) {
    writeEncryptedStore(filePath, encryptionKey, payload);
    assert.throws(() => new EncryptedApplicabilityApiKeyStore(filePath, encryptionKey), /invalid/);
  }
  writeEncryptedStore(filePath, encryptionKey, { version: 1, apiKey: primary });
  const envelope = JSON.parse(readFileSync(filePath, "utf8"));
  envelope.authTag = Buffer.alloc(16).toString("base64");
  writeFileSync(filePath, JSON.stringify(envelope));
  assert.throws(() => new EncryptedApplicabilityApiKeyStore(filePath, encryptionKey), /could not be decrypted/);
});

test("an IP quota rejection makes one request, does not block the key and permits the next explicit search", async (t) => {
  const requests = [];
  let reject = true;
  const { store, service, cache } = fixture(t, async (url) => {
    requests.push(url.searchParams.get("key"));
    return reject ? Response.json(quotaPayload, { status: 401 }) : Response.json([vehicle]);
  });
  service.saveApiKey(primary);
  const state = store.getState();
  await assert.rejects(service.search(query, signal()), PartsApiKeyError);
  assert.deepEqual(requests, [primary]);
  assert.deepEqual(store.getState(), state);
  assert.equal(cache.get(query), null);
  reject = false;
  assert.deepEqual(await service.search(query, signal()), { results: [vehicle], cacheHit: false });
  assert.deepEqual(await service.search(query, signal()), { results: [vehicle], cacheHit: true });
  assert.deepEqual(requests, [primary, primary]);
  service.saveApiKey(replacement);
  await service.search({ ...query, sku: "OEM2" }, signal());
  assert.equal(requests.at(-1), replacement);
});

test("missing key and an already aborted search make no upstream request", async (t) => {
  let calls = 0;
  const { store, service } = fixture(t, async () => { calls += 1; return Response.json([vehicle]); });
  await assert.rejects(service.search(query, signal()), SupplierAuthError);
  store.set(primary);
  await assert.rejects(service.search(query, AbortSignal.abort()), { name: "AbortError" });
  assert.equal(calls, 0);
});

test("late rejection cannot restore a deleted key or overwrite a replacement", async (t) => {
  let finish;
  const { store, service } = fixture(t, () => new Promise((resolve) => { finish = resolve; }));
  for (const next of [null, replacement]) {
    store.set(primary);
    const pending = service.search(query, signal());
    next === null ? store.delete() : store.set(next);
    finish(Response.json(quotaPayload, { status: 401 }));
    await assert.rejects(pending, PartsApiKeyError);
    assert.equal(store.get(), next);
  }
});

test("a single PartsAPI request preserves its eight-second timeout and cannot cache after cancellation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { store, cache, service } = fixture(t, (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }));
  store.set(primary);
  const pending = service.search(query, signal());
  t.mock.timers.tick(8_000);
  await assert.rejects(pending, SupplierTimeoutError);
  assert.equal(cache.get(query), null);
});

test("failed persistence rolls back the single credential on replacement and deletion", (t) => {
  const { store, filePath } = fixture(t);
  store.set(primary);
  const state = store.getState();
  rmSync(filePath);
  mkdirSync(filePath);
  assert.throws(() => store.set(replacement));
  assert.deepEqual(store.getState(), state);
  assert.throws(() => store.delete());
  assert.equal(store.get(), primary);
});
