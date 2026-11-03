import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { readRepairIntegrationSecret } from "../src/backend/config.ts";
import { createAggregatorServer } from "../src/backend/http/create-server.ts";
import { parseRepairCard, RepairValidationError } from "../src/backend/repairs/repair-card.ts";
import { SqliteRepairRepository } from "../src/backend/repairs/sqlite-repair-repository.ts";

// Fictional fixtures used only in isolated temporary databases.
const secret = "test-only-repairs-integration-secret-32-bytes";
const card = {
  documentId: "12345678-abcd-1234-abcd-123456789abc", number: "ТЕСТ-1",
  date: "2026-11-03T14:30:00", vehicleName: "Тестовый контрагент", status: "Тестовое состояние",
};

async function withServer(configuredSecret, check) {
  const directory = await mkdtemp(join(tmpdir(), "aggregator-repairs-http-"));
  const previousPath = process.env.GARAGE_DB_PATH;
  const previousSecret = process.env.ONEC_REPAIRS_INTEGRATION_SECRET;
  process.env.GARAGE_DB_PATH = join(directory, "garage.sqlite");
  if (configuredSecret === null) delete process.env.ONEC_REPAIRS_INTEGRATION_SECRET;
  else process.env.ONEC_REPAIRS_INTEGRATION_SECRET = configuredSecret;
  const reports = [];
  const servers = new Set();
  const start = async () => {
    const server = createAggregatorServer({
      application: { streamSearch: async () => {}, listSupplierSessions: () => [] },
      publicDir: resolve("src/frontend"), reportError: (event) => reports.push(event),
    });
    servers.add(server);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const close = async () => {
      if (!servers.delete(server)) return;
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    };
    return { baseUrl: `http://127.0.0.1:${server.address().port}`, close };
  };
  try {
    await check(await start(), { start, reports });
  } finally {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (previousPath === undefined) delete process.env.GARAGE_DB_PATH;
    else process.env.GARAGE_DB_PATH = previousPath;
    if (previousSecret === undefined) delete process.env.ONEC_REPAIRS_INTEGRATION_SECRET;
    else process.env.ONEC_REPAIRS_INTEGRATION_SECRET = previousSecret;
    await rm(directory, { recursive: true, force: true });
  }
}

const send = (baseUrl, payload, token = secret, options = {}) => fetch(`${baseUrl}/api/integration/1c/repairs`, {
  method: "POST", headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${token}` },
  body: JSON.stringify(payload), ...options,
});

test("repair validation canonicalizes UUID and rejects invalid complete cards and impossible dates", () => {
  assert.deepEqual(parseRepairCard({ ...card, documentId: card.documentId.toUpperCase(), number: " ТЕСТ-1 " }), card);
  assert.equal(parseRepairCard({ ...card, date: "2024-02-29T23:59:59" }).date, "2024-02-29T23:59:59");
  const invalid = [null, [], "text", {}, ...Object.keys(card).map((key) => ({ ...card, [key]: null })),
    ...Object.keys(card).map((key) => ({ ...card, [key]: "" })),
    { ...card, documentId: "00000000-0000-0000-0000-000000000000" }, { ...card, documentId: "not-a-uuid" },
    { ...card, number: "x".repeat(65) }, { ...card, vehicleName: "x".repeat(501) }, { ...card, status: "x".repeat(201) },
    { ...card, vehicleName: "test\nname" }, { ...card, parts: [] },
    ...["2026-02-29T00:00:00", "2026-04-31T00:00:00", "2026-11-03T24:00:00", "2026-11-03T14:60:00",
      "2026-11-03", "2026-11-03T14:30:00Z", "2026-11-03T14:30:00+04:00", "0000-01-01T00:00:00"].map((date) => ({ ...card, date }))];
  for (const payload of invalid) assert.throws(() => parseRepairCard(payload), RepairValidationError);
});

test("repair integration configuration stays optional and rejects weak or malformed values without revealing them", () => {
  const previous = process.env.ONEC_REPAIRS_INTEGRATION_SECRET;
  try {
    delete process.env.ONEC_REPAIRS_INTEGRATION_SECRET;
    assert.equal(readRepairIntegrationSecret(), null);
    process.env.ONEC_REPAIRS_INTEGRATION_SECRET = "";
    assert.equal(readRepairIntegrationSecret(), null);
    process.env.ONEC_REPAIRS_INTEGRATION_SECRET = secret;
    assert.equal(readRepairIntegrationSecret(), secret);
    for (const value of ["weak", " ", "x".repeat(257), "not valid ".repeat(5), `${secret}\n`]) {
      process.env.ONEC_REPAIRS_INTEGRATION_SECRET = value;
      assert.throws(() => readRepairIntegrationSecret(), {
        message: "ONEC_REPAIRS_INTEGRATION_SECRET must contain 32 to 256 ASCII letters, digits, underscores or hyphens",
      });
    }
  } finally {
    if (previous === undefined) delete process.env.ONEC_REPAIRS_INTEGRATION_SECRET;
    else process.env.ONEC_REPAIRS_INTEGRATION_SECRET = previous;
  }
});

test("repair repository stores literal SQL-like text safely without duplicate rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aggregator-repairs-sql-"));
  const repository = new SqliteRepairRepository(join(directory, "repairs.sqlite"));
  try {
    const special = { ...card, vehicleName: "'; DROP TABLE repair_cards; -- <img src=x>" };
    repository.save(special);
    repository.save(special);
    assert.deepEqual(repository.list(), [special]);
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP repairs starts empty, atomically upserts by UUID, sorts and survives a server restart", async () => {
  await withServer(secret, async ({ baseUrl, close }, { start, reports }) => {
    assert.deepEqual(await (await fetch(`${baseUrl}/api/repairs`)).json(), { repairs: [] });
    const created = await send(baseUrl, card);
    assert.equal(created.status, 200);
    assert.equal(created.headers.get("cache-control"), "no-store");
    assert.deepEqual(await created.json(), { repair: card });
    const updated = { ...card, number: "ТЕСТ-2", date: "2026-11-04T08:15:00", vehicleName: "Другой контрагент", status: "Другое состояние" };
    const updates = await Promise.all(Array.from({ length: 8 }, () => send(baseUrl, { ...updated, documentId: card.documentId.toUpperCase() })));
    assert.ok(updates.every((response) => response.status === 200));
    for (const response of updates) assert.deepEqual(await response.json(), { repair: updated });
    const other = { ...card, documentId: "22345678-abcd-1234-abcd-123456789abc", number: updated.number, vehicleName: updated.vehicleName };
    assert.equal((await send(baseUrl, other)).status, 200);
    const list = await fetch(`${baseUrl}/api/repairs`);
    assert.equal(list.headers.get("cache-control"), "no-store");
    assert.deepEqual(await list.json(), { repairs: [updated, other] });
    assert.deepEqual(await (await fetch(`${baseUrl}/api/suppliers/sessions`)).json(), { sessions: [] });
    const vehicle = await fetch(`${baseUrl}/api/garage/vehicles`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Отдельный гараж" }) });
    assert.equal(vehicle.status, 201);
    await close();
    const restarted = await start();
    assert.deepEqual(await (await fetch(`${restarted.baseUrl}/api/repairs`)).json(), { repairs: [updated, other] });
    assert.equal((await (await fetch(`${restarted.baseUrl}/api/garage/vehicles`)).json()).vehicles[0].name, "Отдельный гараж");
    assert.deepEqual(reports, []);
  });
});

test("HTTP repair import fails closed without a configured secret and leaves existing endpoints working", async () => {
  await withServer(null, async ({ baseUrl }) => {
    assert.equal((await send(baseUrl, card)).status, 503);
    assert.deepEqual(await (await fetch(`${baseUrl}/api/repairs`)).json(), { repairs: [] });
    assert.equal((await fetch(baseUrl)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/suppliers/sessions`)).status, 200);
  });
});

test("HTTP repair import authorizes before reading the body and validates methods, content type and size", async () => {
  await withServer(secret, async ({ baseUrl }, { reports }) => {
    for (const authorization of [null, "Bearer wrong", "Basic abc", `Bearer ${"x".repeat(257)}`]) {
      const response = await send(baseUrl, card, secret, { body: "{", headers: { ...(authorization ? { Authorization: authorization } : {}) } });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("www-authenticate"), "Bearer");
      assert.equal((await response.text()).includes(secret), false);
    }
    assert.equal((await send(baseUrl, card, secret, { headers: { Authorization: `Bearer ${secret}`, "Content-Type": "text/plain" } })).status, 415);
    for (const body of ["{", "", "null", "[]", JSON.stringify({ ...card, status: null }), JSON.stringify({ ...card, unexpected: true })]) {
      assert.equal((await send(baseUrl, card, secret, { body })).status, 400);
    }
    assert.equal((await send(baseUrl, card, secret, { body: JSON.stringify({ ...card, vehicleName: "x".repeat(17_000) }) })).status, 413);
    assert.equal((await fetch(`${baseUrl}/api/integration/1c/repairs?secret=${secret}`, { method: "POST" })).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/repairs?limit=1`)).status, 400);
    for (const [path, method, allow] of [["/api/integration/1c/repairs", "GET", "POST"], ["/api/repairs", "POST", "GET"], ["/api/repairs", "OPTIONS", "GET"]]) {
      const response = await fetch(`${baseUrl}${path}`, { method });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("allow"), allow);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    }
    assert.deepEqual(await (await fetch(`${baseUrl}/api/repairs`)).json(), { repairs: [] });
    assert.deepEqual(reports, []);
  });
});


test("test platform isolates copied UUIDs, survives restart and cleanup can never delete working cards", async () => {
  await withServer(secret, async ({ baseUrl, close }, { start }) => {
    assert.equal((await send(baseUrl, card)).status, 200);
    const testCard = { ...card, status: "Тестовая копия", testPlatform: true };
    assert.equal((await send(baseUrl, testCard)).status, 200);
    const updatedTest = { ...testCard, status: "Только новое тестовое состояние" };
    assert.equal((await send(baseUrl, updatedTest)).status, 200);
    assert.deepEqual(await (await fetch(`${baseUrl}/api/repairs`)).json(), { repairs: [card, updatedTest] });
    for (const value of [null, "true", 1, [], {}]) {
      assert.equal((await send(baseUrl, { ...card, testPlatform: value })).status, 400);
    }
    const cleanup = (options = {}) => fetch(`${baseUrl}/api/integration/1c/repairs/test`, {
      method: "DELETE", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmTestCleanup: true }), ...options,
    });
    assert.equal((await cleanup({ headers: { "Content-Type": "application/json" } })).status, 401);
    for (const body of ["{}", "null", "[]", JSON.stringify({ confirmTestCleanup: false }), JSON.stringify({ confirmTestCleanup: true, production: true })]) {
      assert.equal((await cleanup({ body })).status, 400);
    }
    assert.deepEqual(await (await cleanup()).json(), { deleted: 1 });
    assert.deepEqual(await (await cleanup()).json(), { deleted: 0 });
    assert.deepEqual(await (await fetch(`${baseUrl}/api/repairs`)).json(), { repairs: [card] });
    await close();
    const restarted = await start();
    assert.deepEqual(await (await fetch(`${restarted.baseUrl}/api/repairs`)).json(), { repairs: [card] });
  });
});

test("integration status verifies the server secret without requiring or creating a repair", async () => {
  await withServer(secret, async ({ baseUrl }) => {
    const url = `${baseUrl}/api/integration/1c/repairs/status`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { Authorization: "Bearer wrong" } })).status, 401);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { ready: true });
    assert.equal((await fetch(url, { method: "POST" })).status, 405);
    assert.deepEqual(await (await fetch(`${baseUrl}/api/repairs`)).json(), { repairs: [] });
  });
});
