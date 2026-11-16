import assert from "node:assert/strict";
import { test } from "node:test";
import { SearchApplicationService } from "../src/backend/application/search-application-service.ts";
import { SupplierSessionManager } from "../src/backend/session/session-manager.ts";
import { SupplierAuthError } from "../src/backend/suppliers/errors.ts";

const supplierIds = ["rossko", "armtek", "part-kom", "stparts", "forum-auto", "autopiter", "motordetal", "mladov"];
const search = async (service, query = { article: "ABC123" }) => {
  const events = [];
  await service.streamSearch(query, (event) => events.push(event), new AbortController().signal);
  return events;
};

test("default searches use current shared connections for offers, brands and analogs", async () => {
  const sessions = new SupplierSessionManager();
  const calls = [];
  const adapters = supplierIds.map((id) => ({
    id, displayName: id, timeoutMs: 1000,
    async ensureSession() { return sessions.getSession(id); },
    async search() { calls.push([id, "offers"]); },
    ...(!["motordetal", "mladov"].includes(id) ? {
      async searchBrands() { calls.push([id, "brands"]); },
      async searchAnalogs() { calls.push([id, "analogs"]); },
    } : {}),
  }));
  const service = new SearchApplicationService(adapters, sessions, () => assert.fail("unexpected disconnect"));
  assert.deepEqual(await search(service), [
    { type: "search_started", article: "ABC123", suppliers: [] },
    { type: "search_completed", article: "ABC123" },
  ]);
  assert.deepEqual(calls, []);

  sessions.markAuthorized("rossko");
  assert.deepEqual((await search(service))[0].suppliers, ["rossko"]);
  // A connection made after an employee opened the page is included immediately.
  sessions.markAuthorized("autopiter");
  sessions.markAuthorized("motordetal");
  assert.deepEqual((await search(service))[0].suppliers, ["rossko", "autopiter", "motordetal"]);
  for (const mode of ["brands", "analogs"]) {
    const events = await search(service, { article: "ABC123", mode, brand: "TEST" });
    assert.deepEqual(events[0].suppliers, ["rossko", "autopiter"]);
  }
  sessions.markUnauthorized("autopiter");
  assert.deepEqual((await search(service))[0].suppliers, ["rossko", "motordetal"]);
  assert.deepEqual(calls.filter(([id]) => id === "autopiter"), [
    ["autopiter", "offers"], ["autopiter", "brands"], ["autopiter", "analogs"],
  ]);
  // Cart refresh must remain scoped to its supplier; an empty selection stays empty.
  assert.deepEqual((await search(service, { article: "ABC123", suppliers: ["rossko"] }))[0].suppliers, ["rossko"]);
  assert.deepEqual((await search(service, { article: "ABC123", suppliers: [] }))[0].suppliers, []);
});

test("expired authorization is reported without stopping peers and is skipped on the next search", async () => {
  const sessions = new SupplierSessionManager();
  const calls = [];
  const adapters = ["rossko", "autopiter"].map((id) => ({
    id, displayName: id, timeoutMs: 1000,
    async ensureSession() { return sessions.getSession(id); },
    async search() { calls.push(id); if (id === "autopiter") throw new SupplierAuthError(); },
  }));
  adapters.forEach(({ id }) => sessions.markAuthorized(id));
  const service = new SearchApplicationService(adapters, sessions, (id) => sessions.markUnauthorized(id));
  const events = await search(service);
  assert.ok(events.some((event) => event.type === "supplier_status" && event.supplier === "autopiter" && event.status === "auth_error"));
  assert.ok(events.some((event) => event.type === "supplier_status" && event.supplier === "rossko" && event.status === "completed"));
  assert.deepEqual((await search(service))[0].suppliers, ["rossko"]);
  assert.deepEqual(calls, ["rossko", "autopiter", "rossko"]);
});

for (const connectedCount of [1, 4, 8]) {
  for (const users of [1, 10]) {
    test(`${users} simultaneous searches, ${connectedCount} connected suppliers: one parallel call per supplier`, async (t) => {
      const sessions = new SupplierSessionManager();
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const calls = [];
      let sessionChecks = 0;
      const adapters = supplierIds.map((id, index) => {
        if (index < connectedCount) sessions.markAuthorized(id);
        return {
          id, displayName: id, timeoutMs: 2000,
          async ensureSession() { sessionChecks++; return sessions.getSession(id); },
          async validateSession() { assert.fail("no extra preflight authorization request"); },
          async search() { calls.push(id); await gate; },
        };
      });
      const service = new SearchApplicationService(adapters, sessions, () => assert.fail("unexpected disconnect"));
      const pending = Array.from({ length: users }, () => search(service));
      try {
        await new Promise(setImmediate);
        // All calls start before any external response: no sequential supplier waits.
        assert.equal(calls.length, users * connectedCount);
        assert.equal(sessionChecks, calls.length);
        for (const id of supplierIds.slice(0, connectedCount)) assert.equal(calls.filter((called) => called === id).length, users);
      } finally { release(); }
      const completed = await Promise.all(pending);
      completed.forEach((events) => assert.deepEqual(events[0].suppliers, supplierIds.slice(0, connectedCount)));
      t.diagnostic(`${calls.length} adapter searches, ${sessionChecks} in-memory session checks, 0 validation requests`);
    });
  }
}
