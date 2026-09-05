import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  decodeRosskoApiCredentials,
  encodeRosskoApiCredentials,
  SupplierSessionService,
} from "../src/backend/application/supplier-session-service.ts";
import { EncryptedSupplierCredentialStore } from "../src/backend/session/encrypted-credential-store.ts";
import { SupplierSessionManager } from "../src/backend/session/session-manager.ts";
import { writeJsonStateFileAtomic } from "../src/backend/session/state-file.ts";
import { SupplierAuthError } from "../src/backend/suppliers/errors.ts";
import { runSupplierSearch } from "../src/backend/suppliers/run-supplier-search.ts";

test("atomic state replacement preserves the previous file when commit is invalidated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autoservice-state-test-"));
  const statePath = join(directory, "session.json");

  try {
    writeJsonStateFileAtomic(statePath, { generation: 1 });
    let commitChecks = 0;
    assert.throws(
      () => writeJsonStateFileAtomic(statePath, { generation: 2 }, () => {
        commitChecks += 1;
        return commitChecks === 1;
      }),
      /session was invalidated/i,
    );
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), { generation: 1 });
    assert.deepEqual(await readdir(directory), ["session.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("supplier credentials are authenticated, encrypted, and removable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autoservice-credentials-test-"));
  const statePath = join(directory, "credentials.enc.json");
  const key = randomBytes(32);

  try {
    const store = new EncryptedSupplierCredentialStore(statePath, key);
    store.set("rossko", { login: "saved-login", password: " saved-password " });

    const encryptedFile = await readFile(statePath, "utf8");
    assert.equal(encryptedFile.includes("saved-login"), false);
    assert.equal(encryptedFile.includes("saved-password"), false);
    assert.deepEqual(
      new EncryptedSupplierCredentialStore(statePath, key).get("rossko"),
      { login: "saved-login", password: " saved-password " },
    );
    assert.throws(
      () => new EncryptedSupplierCredentialStore(statePath, randomBytes(32)),
      /could not be decrypted/i,
    );

    store.delete("rossko");
    assert.equal(existsSync(statePath), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session invalidation aborts active operations and advances generation", () => {
  const sessionManager = new SupplierSessionManager();
  const operation = sessionManager.beginOperation("rossko", new AbortController().signal);

  assert.equal(operation.isCurrent(), true);
  sessionManager.invalidateOperations("rossko");
  assert.equal(operation.signal.aborted, true);
  assert.equal(operation.isCurrent(), false);

  const nextOperation = sessionManager.beginOperation("rossko", new AbortController().signal);
  assert.equal(nextOperation.generation, operation.generation + 1);
  assert.equal(nextOperation.isCurrent(), true);
  operation.dispose();
  nextOperation.dispose();
});

test("disposing a stale operation does not untrack a newer operation", () => {
  const sessionManager = new SupplierSessionManager();
  const staleOperation = sessionManager.beginOperation("mladov", new AbortController().signal);
  sessionManager.invalidateOperations("mladov");
  const currentOperation = sessionManager.beginOperation("mladov", new AbortController().signal);

  staleOperation.dispose();
  sessionManager.invalidateOperations("mladov");

  assert.equal(currentOperation.signal.aborted, true);
  assert.equal(currentOperation.isCurrent(), false);
  currentOperation.dispose();
});

test("establishing a new session invalidates operations from the previous session", () => {
  const sessionManager = new SupplierSessionManager();
  const oldSearch = sessionManager.beginOperation("motordetal", new AbortController().signal);
  const authorization = sessionManager.beginOperation("motordetal", new AbortController().signal);

  authorization.supersedeOthers();

  assert.equal(oldSearch.signal.aborted, true);
  assert.equal(oldSearch.isCurrent(), false);
  assert.equal(authorization.signal.aborted, false);
  assert.equal(authorization.isCurrent(), true);
  oldSearch.dispose();
  authorization.dispose();
});

test("exclusive authorization blocks searches until it finishes", () => {
  const sessionManager = new SupplierSessionManager();
  const oldSearch = sessionManager.beginOperation("mladov", new AbortController().signal);
  const authorization = sessionManager.beginExclusiveOperation("mladov", new AbortController().signal);
  const searchDuringAuthorization = sessionManager.beginOperation("mladov", new AbortController().signal);

  assert.equal(oldSearch.signal.aborted, true);
  assert.equal(authorization.signal.aborted, false);
  assert.equal(searchDuringAuthorization.signal.aborted, true);

  oldSearch.dispose();
  searchDuringAuthorization.dispose();
  authorization.dispose();
  const laterSearch = sessionManager.beginOperation("mladov", new AbortController().signal);
  assert.equal(laterSearch.signal.aborted, false);
  laterSearch.dispose();
});

test("rejected credential rotation preserves the active session but reports authorization failure", async () => {
  const sessionManager = new SupplierSessionManager();
  sessionManager.markAuthorized("rossko", "Existing session");
  const sessionService = new SupplierSessionService([], sessionManager, {
    async verifyRosskoApiCredentials() {
      throw new SupplierAuthError("rejected keys");
    },
  });

  await assert.rejects(
    sessionService.authorizeRossko(
      { key1: "replacement", key2: "rejected" },
      new AbortController().signal,
    ),
    SupplierAuthError,
  );
  assert.equal(sessionManager.getSession("rossko").authorized, true);
  assert.equal(sessionManager.getSession("rossko").details, "Rossko API отклонил K1 или K2");
});

test("Rossko API credentials are marked so legacy website credentials cannot be reused as keys", () => {
  const encoded = encodeRosskoApiCredentials({ key1: "api-key-one", key2: "api-key-two" });
  assert.deepEqual(decodeRosskoApiCredentials(encoded), { key1: "api-key-one", key2: "api-key-two" });
  assert.equal(decodeRosskoApiCredentials({ login: "legacy-login", password: "legacy-password" }), null);
});

test("expired validation automatically authorizes once with stored credentials", async () => {
  const sessionManager = new SupplierSessionManager();
  sessionManager.markAuthorized("part-kom");
  const credentials = { login: "saved-login", password: "saved-password" };
  const stored = new Map([["part-kom", credentials]]);
  let authorizationChecks = 0;
  const sessionService = new SupplierSessionService([
    {
      id: "part-kom",
      displayName: "PartKOM",
      timeoutMs: 1000,
      async ensureSession() {
        return sessionManager.getSession("part-kom");
      },
      async validateSession() {
        throw new SupplierAuthError("expired");
      },
    },
  ], sessionManager, {
    async verifyPartKomApiCredentials(received) {
      authorizationChecks += 1;
      assert.deepEqual(received, credentials);
    },
  }, {
    get(supplier) {
      return stored.get(supplier) ?? null;
    },
    set(supplier, value) {
      stored.set(supplier, value);
    },
    delete(supplier) {
      stored.delete(supplier);
    },
  });

  const validation = await sessionService.validateSupplierSessions(
    "ABC-123",
    ["part-kom"],
    new AbortController().signal,
  );

  assert.deepEqual(validation.results, [{ supplier: "part-kom", status: "connected" }]);
  assert.equal(authorizationChecks, 1);
  assert.equal(sessionManager.getSession("part-kom").authorized, true);
});

test("invalidated supplier search cannot emit late results", async () => {
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
    async search(_query, context, onResult) {
      sessionManager.invalidateOperations("rossko");
      onResult({
        supplier: "rossko",
        brand: "Brand",
        article: "ABC-123",
        title: "Late result",
        price: 100,
        warehouse: null,
        deliveryDate: null,
        deliveryDateApproximate: false,
        link: "https://rossko.ru/product",
      });
      throw context.signal.reason;
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
    { type: "supplier_status", supplier: "rossko", status: "auth_error", details: "Supplier authorization is required" },
  ]);
});
