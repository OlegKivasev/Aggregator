import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readRepairIntegrationSecret } from "../src/backend/config.ts";
import { createAggregatorServer } from "../src/backend/http/create-server.ts";
import { parseRepairCard, RepairValidationError } from "../src/backend/repairs/repair-card.ts";
import { SqliteRepairRepository } from "../src/backend/repairs/sqlite-repair-repository.ts";

// Fictional fixtures used only in isolated temporary databases.
const secret = "test-only-repairs-integration-secret-32-bytes";
const card = {
  documentId: "12345678-abcd-1234-abcd-123456789abc", number: "ТЕСТ-1",
  date: "2026-11-03T14:30:00", vehicleName: "Тестовый контрагент", status: "В работе",
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

test("repair payment status accepts only 1C contract values and leaves legacy cards unknown", () => {
  assert.equal(parseRepairCard(card).paymentStatus, undefined);
  for (const paymentStatus of ["paid", "payment_required"]) {
    assert.deepEqual(parseRepairCard({ ...card, paymentStatus }), { ...card, paymentStatus });
  }
  for (const paymentStatus of [null, false, 0, {}, [], "", "PAID", " paid ", "Оплачено", "<script>"]) {
    assert.throws(() => parseRepairCard({ ...card, paymentStatus }), /paymentStatus:/);
  }
  for (const amountDue of [0.01, 0.29, 10_500, 10_500.01, 9_999_999_999_999.99]) {
    for (const paymentStatus of ["partially_paid", "payment_required"]) {
      const detailed = { ...card, paymentStatus, amountDue };
      assert.deepEqual(parseRepairCard(detailed), detailed);
    }
  }
  assert.deepEqual(parseRepairCard({ ...card, paymentStatus: "paid", amountDue: 0 }), { ...card, paymentStatus: "paid", amountDue: 0 });
  for (const amountDue of [null, "10500", -1, NaN, Infinity, 0, 0.001, 10_500.001, 1e20, {}, []]) {
    assert.throws(() => parseRepairCard({ ...card, paymentStatus: "partially_paid", amountDue }), /amountDue:/);
  }
  for (const metadata of [{ paymentStatus: "partially_paid" }, { amountDue: 10 },
    { paymentStatus: "paid", amountDue: 10 }, { paymentStatus: "payment_required", amountDue: 0 }]) {
    assert.throws(() => parseRepairCard({ ...card, ...metadata }), /amountDue:/);
  }
});

test("1C payment changes round-trip, persist, and remain independent for both repair platforms", async () => {
  await withServer(secret, async ({ baseUrl, close }, { start }) => {
    const production = { ...card, paymentStatus: "payment_required", amountDue: 20_500 };
    const testCard = { ...card, testPlatform: true, paymentStatus: "paid", amountDue: 0 };
    assert.deepEqual(await (await send(baseUrl, production)).json(), { repair: production });
    assert.deepEqual(await (await send(baseUrl, testCard)).json(), { repair: testCard });
    for (const metadata of [{ paymentStatus: "partially_paid" }, { paymentStatus: "partially_paid", amountDue: 0 },
      { paymentStatus: "paid", amountDue: 1 }, { paymentStatus: "payment_required", amountDue: -1 }]) {
      const response = await send(baseUrl, { ...card, ...metadata });
      assert.equal(response.status, 400);
      assert.match((await response.json()).message, /^amountDue:/);
    }
    for (const paymentStatus of [null, "invalid", 1]) {
      const response = await send(baseUrl, { ...card, paymentStatus });
      assert.equal(response.status, 400);
      assert.match((await response.json()).message, /^paymentStatus:/);
    }
    await close();
    const restarted = await start();
    baseUrl = restarted.baseUrl;
    const list = async () => (await (await fetch(`${baseUrl}/api/repairs`)).json()).repairs;
    assert.deepEqual(await list(), [production, testCard]);
    const partial = { ...production, paymentStatus: "partially_paid", amountDue: 10_500.29 };
    assert.deepEqual(await (await send(baseUrl, partial)).json(), { repair: partial });
    assert.deepEqual(await list(), [partial, testCard]);
    const paid = { ...production, paymentStatus: "paid", amountDue: 0 };
    await send(baseUrl, paid);
    assert.deepEqual(await list(), [paid, testCard]);
    // A complete older payload must clear the status rather than leave a stale "paid" label.
    await send(baseUrl, card);
    assert.deepEqual(await list(), [card, testCard]);
    const testDebt = { ...testCard, paymentStatus: "partially_paid", amountDue: 0.29 };
    await send(baseUrl, testDebt);
    assert.deepEqual(await list(), [card, testDebt]);
  });
});

test("two-status SQLite migration preserves both repair platforms, unknown debts, metadata and restart behavior", async () => {
  const directory = await mkdtemp(join(tmpdir(), "repair-payment-migration-"));
  const path = join(directory, "test.sqlite");
  const old = new DatabaseSync(path);
  const stored = { ...card, responsibleFio: "Тестовый сотрудник", counterpartyName: "Тестовый автопарк",
    goodsReadiness: { totalPositions: 5, availablePositions: 2 }, paymentStatus: "payment_required" };
  try {
    for (const table of ["repair_cards", "test_repair_cards"]) {
      old.exec(`CREATE TABLE ${table} (document_id TEXT PRIMARY KEY NOT NULL, number TEXT NOT NULL,
        date TEXT NOT NULL, vehicle_name TEXT NOT NULL, status TEXT NOT NULL, responsible_fio TEXT,
        counterparty_name TEXT, goods_total_positions INTEGER, goods_available_positions INTEGER,
        payment_status TEXT CHECK (payment_status IN ('paid', 'payment_required'))) STRICT`);
      const insert = old.prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      insert.run(card.documentId, card.number, card.date, card.vehicleName, card.status, stored.responsibleFio, stored.counterpartyName, 5, 2, stored.paymentStatus);
    }
    old.exec("CREATE TABLE unrelated_data (value TEXT); INSERT INTO unrelated_data VALUES ('keep')");
  } finally { old.close(); }
  let repository;
  try {
    repository = new SqliteRepairRepository(path);
    assert.deepEqual(repository.list(), [stored, { ...stored, testPlatform: true }]);
    const partial = { ...stored, paymentStatus: "partially_paid", amountDue: 10_500.29 };
    repository.save(partial);
    repository.close();
    repository = new SqliteRepairRepository(path);
    assert.deepEqual(repository.list(), [partial, { ...stored, testPlatform: true }]);
    const testPartial = { ...partial, testPlatform: true, amountDue: 0.29 };
    repository.save(testPartial);
    const paid = { ...partial, paymentStatus: "paid", amountDue: 0 };
    repository.save(paid);
    assert.deepEqual(repository.list(), [paid, testPartial]);
    const read = new DatabaseSync(path);
    try {
      assert.equal(read.prepare("SELECT amount_due_minor FROM test_repair_cards").get().amount_due_minor, 29);
      assert.equal(read.prepare("SELECT value FROM unrelated_data").get().value, "keep");
    } finally { read.close(); }
  } finally { repository?.close(); await rm(directory, { recursive: true, force: true }); }
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
    // The 1C acknowledgement treats omitted testPlatform as the production mode.
    const explicitProduction = await send(baseUrl, { ...card, testPlatform: false });
    assert.equal(explicitProduction.status, 200);
    assert.deepEqual(await explicitProduction.json(), { repair: card });
    const updated = { ...card, number: "ТЕСТ-2", date: "2026-11-04T08:15:00", vehicleName: "Другой контрагент", status: "В работе" };
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
    for (const [path, method, allow] of [["/api/integration/1c/repairs", "GET", "POST, DELETE"], ["/api/repairs", "POST", "GET"], ["/api/repairs", "OPTIONS", "GET"]]) {
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
    const testCard = { ...card, status: "В работе", testPlatform: true };
    const acceptedTest = await send(baseUrl, testCard);
    assert.equal(acceptedTest.status, 200);
    assert.deepEqual(await acceptedTest.json(), { repair: testCard });
    const updatedTest = { ...testCard, vehicleName: "Обновлённая тестовая машина" };
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
    assert.deepEqual(await response.json(), { ready: true, cards: { production: 0, test: 0 } });
    assert.equal((await fetch(url, { method: "POST" })).status, 405);
    assert.deepEqual(await (await fetch(`${baseUrl}/api/repairs`)).json(), { repairs: [] });
  });
});


test("legal repair cards validate counterparty and retain an honest empty contract", () => {
  const legal = { ...card, vehicleName: "Договор — тестовый автомобиль", counterpartyName: 'ООО «Тестовый автопарк»' };
  assert.deepEqual(parseRepairCard({ ...legal, counterpartyName: ` ${legal.counterpartyName} ` }), legal);
  assert.deepEqual(parseRepairCard({ ...legal, vehicleName: "" }), { ...legal, vehicleName: "" });
  for (const counterpartyName of [null, "", " ", 42, {}, "x".repeat(501), "name\nvalue"]) {
    assert.throws(() => parseRepairCard({ ...legal, counterpartyName }), RepairValidationError);
  }
  for (const vehicleName of [null, undefined, 42]) {
    assert.throws(() => parseRepairCard({ ...legal, vehicleName }), RepairValidationError);
  }
  assert.throws(() => parseRepairCard({ ...card, vehicleName: "" }), RepairValidationError);
});

test("only In Progress repairs are listed and status changes hide, persist and restore each platform", async () => {
  await withServer(secret, async ({ baseUrl, close }, { start }) => {
    const legal = { ...card, vehicleName: "Автомобиль по договору", counterpartyName: 'ООО «Тестовая организация»' };
    const testCard = { ...legal, vehicleName: "Тестовая машина", testPlatform: true };
    for (const value of [legal, testCard]) {
      const response = await send(baseUrl, value);
      assert.deepEqual(await response.json(), { repair: value });
    }
    assert.deepEqual(await (await fetch(`${baseUrl}/api/repairs`)).json(), { repairs: [legal, testCard] });
    for (const status of ["Завершен", "Ожидание", "Принят", "в работе", "В работе!"]) {
      const response = await send(baseUrl, { ...legal, status });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).repair.status, status);
      assert.deepEqual(await (await fetch(`${baseUrl}/api/repairs`)).json(), { repairs: [testCard] });
    }
    assert.equal((await send(baseUrl, { ...testCard, status: "Завершен" })).status, 200);
    await close();
    const restarted = await start();
    assert.deepEqual(await (await fetch(`${restarted.baseUrl}/api/repairs`)).json(), { repairs: [] });
    assert.deepEqual(await (await send(restarted.baseUrl, { ...legal, vehicleName: "" })).json(), { repair: { ...legal, vehicleName: "" } });
    assert.deepEqual(await (await fetch(`${restarted.baseUrl}/api/repairs`)).json(), { repairs: [{ ...legal, vehicleName: "" }] });
    assert.equal((await send(restarted.baseUrl, card)).status, 200);
    assert.deepEqual(await (await fetch(`${restarted.baseUrl}/api/repairs`)).json(), { repairs: [card] });
  });
});

test("existing repair SQLite migrates both tables without losing active or hidden cards", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aggregator-repairs-migration-"));
  const path = join(directory, "garage.sqlite");
  const original = new DatabaseSync(path);
  try {
    for (const table of ["repair_cards", "test_repair_cards"]) {
      original.exec(`CREATE TABLE ${table} (
        document_id TEXT PRIMARY KEY NOT NULL, number TEXT NOT NULL, date TEXT NOT NULL,
        vehicle_name TEXT NOT NULL, status TEXT NOT NULL
      ) STRICT`);
      const insert = original.prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?, ?)`);
      insert.run(card.documentId, card.number, card.date, card.vehicleName, card.status);
      insert.run("22345678-abcd-1234-abcd-123456789abc", "ТЕСТ-СКРЫТ", card.date, "Завершённая машина", "Завершен");
    }
    original.exec("CREATE TABLE unrelated_data (value TEXT); INSERT INTO unrelated_data VALUES ('preserved')");
  } finally { original.close(); }
  let repository;
  try {
    repository = new SqliteRepairRepository(path);
    assert.deepEqual(repository.list(), [card, { ...card, testPlatform: true }]);
    const legal = { ...card, vehicleName: "Договор", counterpartyName: "ООО Тест" };
    repository.save(legal);
    repository.save({ ...legal, testPlatform: true, counterpartyName: "ООО Тестовая копия" });
    repository.close();
    repository = new SqliteRepairRepository(path);
    assert.deepEqual(repository.list(), [legal, { ...legal, testPlatform: true, counterpartyName: "ООО Тестовая копия" }]);
    const inspection = new DatabaseSync(path);
    try {
      for (const table of ["repair_cards", "test_repair_cards"]) {
        assert.equal(inspection.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 2);
        assert.equal(inspection.prepare(`SELECT status FROM ${table} WHERE number = 'ТЕСТ-СКРЫТ'`).get().status, "Завершен");
      }
      assert.equal(inspection.prepare("SELECT value FROM unrelated_data").get().value, "preserved");
    } finally { inspection.close(); }
  } finally {
    repository?.close();
    await rm(directory, { recursive: true, force: true });
  }
});


test("goods readiness accepts verified empty/full/partial position counts and rejects false or ambiguous data", () => {
  for (const goodsReadiness of [{ totalPositions: 0, availablePositions: 0 }, { totalPositions: 5, availablePositions: 2 }, { totalPositions: 5, availablePositions: 5 }]) {
    assert.deepEqual(parseRepairCard({ ...card, goodsReadiness }), { ...card, goodsReadiness });
  }
  const invalid = [null, false, [], {}, { totalPositions: 0 }, { availablePositions: 0 },
    { totalPositions: 0, availablePositions: 1 }, { totalPositions: 2, availablePositions: -1 },
    { totalPositions: -1, availablePositions: 0 }, { totalPositions: 2.5, availablePositions: 1 },
    { totalPositions: 2, availablePositions: 0.5 }, { totalPositions: "2", availablePositions: 1 },
    { totalPositions: 100_001, availablePositions: 0 }, { totalPositions: 2, availablePositions: 1, extra: true }];
  for (const goodsReadiness of invalid) assert.throws(() => parseRepairCard({ ...card, goodsReadiness }), /goodsReadiness:/);
});

test("HTTP readiness persists separately for test/live cards, updates and never invents availability for legacy imports", async () => {
  await withServer(secret, async ({ baseUrl, close }, { start, reports }) => {
    const partial = { ...card, goodsReadiness: { totalPositions: 5, availablePositions: 2 } };
    const fullTest = { ...card, testPlatform: true, goodsReadiness: { totalPositions: 5, availablePositions: 5 } };
    assert.deepEqual(await (await send(baseUrl, partial)).json(), { repair: partial });
    assert.deepEqual(await (await send(baseUrl, fullTest)).json(), { repair: fullTest });
    assert.deepEqual(await (await fetch(`${baseUrl}/api/repairs`)).json(), { repairs: [partial, fullTest] });
    for (const goodsReadiness of [null, { totalPositions: 1, availablePositions: 2 }]) {
      const invalid = await send(baseUrl, { ...card, goodsReadiness });
      assert.equal(invalid.status, 400);
      assert.match((await invalid.json()).message, /^goodsReadiness:/);
    }
    assert.deepEqual(await (await fetch(`${baseUrl}/api/repairs`)).json(), { repairs: [partial, fullTest] });
    await close();
    const restarted = await start();
    assert.deepEqual(await (await fetch(`${restarted.baseUrl}/api/repairs`)).json(), { repairs: [partial, fullTest] });
    const empty = { ...card, goodsReadiness: { totalPositions: 0, availablePositions: 0 } };
    assert.deepEqual(await (await send(restarted.baseUrl, empty)).json(), { repair: empty });
    assert.deepEqual(await (await fetch(`${restarted.baseUrl}/api/repairs`)).json(), { repairs: [empty, fullTest] });
    assert.equal((await send(restarted.baseUrl, card)).status, 200);
    assert.deepEqual(await (await fetch(`${restarted.baseUrl}/api/repairs`)).json(), { repairs: [card, fullTest] });
    assert.deepEqual(reports, []);
  });
});

test("source removes an ineligible repair by UUID with strict authentication, test isolation, idempotency and durable counts", async () => {
  await withServer(secret, async ({ baseUrl, close }, { start }) => {
    const remove = (origin, body, token = secret) => fetch(`${origin}/api/integration/1c/repairs`, {
      method: "DELETE", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const status = async (origin) => (await fetch(`${origin}/api/integration/1c/repairs/status`, {
      headers: { Authorization: `Bearer ${secret}` },
    })).json();
    await send(baseUrl, card);
    await send(baseUrl, { ...card, testPlatform: true });
    assert.equal((await remove(baseUrl, { documentId: card.documentId }, "wrong")).status, 401);
    for (const body of [null, [], {}, { documentId: "wrong" }, { documentId: card.documentId, testPlatform: "true" },
      { documentId: card.documentId, confirmTestCleanup: true }, { documentId: card.documentId, posted: false }]) {
      assert.equal((await remove(baseUrl, body)).status, 400);
    }
    assert.deepEqual(await status(baseUrl), { ready: true, cards: { production: 1, test: 1 } });
    const identity = { documentId: card.documentId, testPlatform: true };
    const response = await remove(baseUrl, identity);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { ...identity, deleted: 1 });
    assert.deepEqual(await (await remove(baseUrl, identity)).json(), { ...identity, deleted: 0 });
    assert.deepEqual(await (await fetch(`${baseUrl}/api/repairs`)).json(), { repairs: [card] });
    await close();
    const restarted = await start();
    assert.deepEqual(await status(restarted.baseUrl), { ready: true, cards: { production: 1, test: 0 } });
    assert.deepEqual(await (await remove(restarted.baseUrl, { documentId: card.documentId })).json(), {
      documentId: card.documentId, testPlatform: false, deleted: 1,
    });
    assert.deepEqual(await status(restarted.baseUrl), { ready: true, cards: { production: 0, test: 0 } });
    assert.deepEqual(await (await fetch(`${restarted.baseUrl}/api/repairs`)).json(), { repairs: [] });
    assert.equal((await send(restarted.baseUrl, card)).status, 200);
    assert.deepEqual(await (await fetch(`${restarted.baseUrl}/api/repairs`)).json(), { repairs: [card] });
  });
});

test("platform counts and explicitly confirmed production cleanup remain isolated across restart", async () => {
  await withServer(secret, async ({ baseUrl, close }, { start }) => {
    const headers = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };
    const status = () => fetch(`${baseUrl}/api/integration/1c/repairs/status`, { headers }).then((response) => response.json());
    const cleanup = (options = {}) => fetch(`${baseUrl}/api/integration/1c/repairs/production`, {
      method: "DELETE", headers, body: JSON.stringify({ confirmProductionCleanup: true }), ...options,
    });
    const testCard = { ...card, testPlatform: true };
    await send(baseUrl, testCard);
    assert.deepEqual(await status(), { ready: true, cards: { production: 0, test: 1 } });
    await send(baseUrl, card);
    await send(baseUrl, card);
    assert.deepEqual(await status(), { ready: true, cards: { production: 1, test: 1 } });
    assert.equal((await cleanup({ headers: { "Content-Type": "application/json" } })).status, 401);
    assert.equal((await cleanup({ headers: { ...headers, "Content-Type": "text/plain" } })).status, 415);
    for (const body of ["{", "null", "[]", "{}", JSON.stringify({ confirmTestCleanup: true }),
      JSON.stringify({ confirmProductionCleanup: false }), JSON.stringify({ confirmProductionCleanup: true, extra: true })]) {
      assert.equal((await cleanup({ body })).status, 400);
    }
    assert.equal((await cleanup({ body: JSON.stringify({ text: "x".repeat(17_000) }) })).status, 413);
    const wrongMethod = await fetch(`${baseUrl}/api/integration/1c/repairs/production`, { headers });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "DELETE");
    assert.deepEqual(await status(), { ready: true, cards: { production: 1, test: 1 } });
    assert.deepEqual(await (await cleanup()).json(), { deleted: 1 });
    assert.deepEqual(await (await cleanup()).json(), { deleted: 0 });
    assert.deepEqual(await status(), { ready: true, cards: { production: 0, test: 1 } });
    assert.deepEqual(await (await fetch(`${baseUrl}/api/repairs`)).json(), { repairs: [testCard] });
    await close();
    const restarted = await start();
    assert.deepEqual(await (await fetch(`${restarted.baseUrl}/api/repairs`)).json(), { repairs: [testCard] });
  });
});

test("repair rechecks accept current 1C metadata and safely remove only the selected UUID and platform", async () => {
  await withServer(secret, async ({ baseUrl, close }, { start }) => {
    const detailed = { ...card, counterpartyName: "Тестовое юридическое лицо",
      goodsReadiness: { totalPositions: 3, availablePositions: 1 } };
    assert.deepEqual(await (await send(baseUrl, detailed)).json(), { repair: detailed });
    const testCard = { ...detailed, testPlatform: true, goodsReadiness: { totalPositions: 3, availablePositions: 3 } };
    await send(baseUrl, testCard);
    const other = { ...card, documentId: "22345678-abcd-1234-abcd-123456789abc", number: "ТЕСТ-2" };
    await send(baseUrl, other);
    for (const goodsReadiness of [null, [], {}, { totalPositions: 1, availablePositions: 2 },
      { totalPositions: 1.5, availablePositions: 0 }, { totalPositions: -1, availablePositions: 0 },
      { totalPositions: 100001, availablePositions: 0 }, { totalPositions: 1, availablePositions: -1 },
      { totalPositions: "1", availablePositions: 0 }, { totalPositions: 1, availablePositions: 0, extra: true }]) {
      assert.equal((await send(baseUrl, { ...detailed, goodsReadiness })).status, 400);
    }
    for (const counterpartyName of [null, "", 1, "x".repeat(501)]) {
      assert.equal((await send(baseUrl, { ...detailed, counterpartyName })).status, 400);
    }
    await close();
    const restarted = await start();
    baseUrl = restarted.baseUrl;
    assert.deepEqual(await (await fetch(`${baseUrl}/api/repairs`)).json(), { repairs: [detailed, testCard, other] });
    const remove = (payload, options = {}) => fetch(`${baseUrl}/api/integration/1c/repairs`, {
      method: "DELETE", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload), ...options,
    });
    const selection = { documentId: card.documentId, testPlatform: false };
    assert.equal((await remove(selection, { headers: { "Content-Type": "application/json" } })).status, 401);
    for (const payload of [null, [], {}, { testPlatform: false }, { ...selection, testPlatform: "false" },
      { ...selection, extra: true }, { ...selection, documentId: "not-a-uuid" }]) {
      assert.equal((await remove(payload)).status, 400);
    }
    assert.deepEqual(await (await remove(selection)).json(), { ...selection, deleted: 1 });
    assert.deepEqual(await (await remove(selection)).json(), { ...selection, deleted: 0 });
    assert.deepEqual(await (await fetch(`${baseUrl}/api/repairs`)).json(), { repairs: [testCard, other] });
    // A full replacement also removes obsolete optional metadata.
    await send(baseUrl, { ...card, testPlatform: true });
    assert.deepEqual(await (await fetch(`${baseUrl}/api/repairs`)).json(), { repairs: [{ ...card, testPlatform: true }, other] });
  });
});

test("repair metadata migration preserves existing production and test rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aggregator-repairs-migration-"));
  const path = join(directory, "repairs.sqlite");
  const legacy = new DatabaseSync(path);
  try {
    for (const table of ["repair_cards", "test_repair_cards"]) {
      legacy.exec(`CREATE TABLE ${table} (document_id TEXT PRIMARY KEY NOT NULL, number TEXT NOT NULL,
        date TEXT NOT NULL, vehicle_name TEXT NOT NULL, status TEXT NOT NULL) STRICT`);
      legacy.prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?, ?)`).run(...Object.values(card));
    }
  } finally { legacy.close(); }
  let repository;
  try {
    repository = new SqliteRepairRepository(path);
    assert.deepEqual(repository.list(), [card, { ...card, testPlatform: true }]);
    const updated = { ...card, goodsReadiness: { totalPositions: 0, availablePositions: 0 }, paymentStatus: "paid" };
    repository.save(updated);
    repository.close();
    repository = new SqliteRepairRepository(path);
    assert.deepEqual(repository.list(), [updated, { ...card, testPlatform: true }]);
  } finally {
    repository?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const schema of ["original", "regressed", "mixed"]) {
  test(`readiness recovery preserves ${schema} SQLite data in both platforms without another 1C export`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "aggregator-readiness-recovery-"));
    const path = join(directory, "repairs.sqlite");
    const stored = { ...card, vehicleName: "Машина из договора", counterpartyName: "Тестовый автопарк",
      goodsReadiness: { totalPositions: 5, availablePositions: 2 } };
    const untouched = { ...card, documentId: "22345678-abcd-1234-abcd-123456789abc", vehicleName: "Другая машина",
      goodsReadiness: { totalPositions: 7, availablePositions: 4 } };
    const before = new DatabaseSync(path);
    try {
      for (const table of ["repair_cards", "test_repair_cards"]) {
        before.exec(`CREATE TABLE ${table} (document_id TEXT PRIMARY KEY NOT NULL, number TEXT NOT NULL,
          date TEXT NOT NULL, vehicle_name TEXT NOT NULL, status TEXT NOT NULL, counterparty_name TEXT
          ${schema !== "regressed" ? ", goods_total_positions INTEGER, goods_available_positions INTEGER" : ""}
          ${schema !== "original" ? ", total_positions INTEGER, available_positions INTEGER" : ""}) STRICT`);
        const originalValues = schema === "regressed" ? [] : [5, schema === "mixed" ? 1 : 2];
        const regressedValues = schema === "original" ? [] : [5, 2];
        const values = [card.documentId, card.number, card.date, stored.vehicleName, card.status, stored.counterpartyName,
          ...originalValues, ...regressedValues];
        before.prepare(`INSERT INTO ${table} VALUES (${values.map(() => "?").join(",")})`).run(...values);
        if (schema === "mixed") {
          // Yesterday's card with untouched original counters and only NULLs in the incorrect columns.
          before.prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            untouched.documentId, card.number, card.date, untouched.vehicleName, card.status, null, 7, 4, null, null);
        }
      }
      before.exec("CREATE TABLE unrelated_data (value TEXT); INSERT INTO unrelated_data VALUES ('preserved')");
    } finally { before.close(); }
    let repository;
    try {
      repository = new SqliteRepairRepository(path);
      const expected = [stored, { ...stored, testPlatform: true },
        ...(schema === "mixed" ? [untouched, { ...untouched, testPlatform: true }] : [])];
      assert.deepEqual(repository.list(), expected);
      assert.deepEqual(repository.counts(), { production: expected.length / 2, test: expected.length / 2 });
      const inspection = new DatabaseSync(path);
      try {
        for (const table of ["repair_cards", "test_repair_cards"]) {
          const columns = inspection.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
          assert.ok(columns.includes("goods_total_positions") && columns.includes("goods_available_positions"));
          assert.ok(!columns.includes("total_positions") && !columns.includes("available_positions"));
        }
        assert.equal(inspection.prepare("SELECT value FROM unrelated_data").get().value, "preserved");
      } finally { inspection.close(); }
      const updated = { ...stored, goodsReadiness: { totalPositions: 5, availablePositions: 5 } };
      repository.save(updated);
      repository.close();
      repository = new SqliteRepairRepository(path);
      assert.deepEqual(repository.list(), [updated, ...expected.slice(1)]);
    } finally {
      repository?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
