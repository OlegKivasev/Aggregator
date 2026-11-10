import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { UserAuthService } from "../src/backend/auth/user-auth-service.ts";
import { createAggregatorServer } from "../src/backend/http/create-server.ts";

const secret = "isolated-test-repair-refresh-secret-32-bytes";
const first = { documentId: "12345678-abcd-1234-abcd-123456789abc", number: "ТЕСТ-1", date: "2026-11-03T14:30:00",
  vehicleName: "Тестовая машина", status: "В работе", responsibleFio: "Первый сотрудник", goodsReadiness: { totalPositions: 3, availablePositions: 1 }, paymentStatus: "payment_required" };
const second = { ...first, documentId: "22345678-abcd-1234-abcd-123456789abc", number: "ТЕСТ-2", vehicleName: "Вторая машина" };
const json = (value, headers = {}) => ({ headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(value) });
async function withServer(check, authenticated = false) {
  const directory = await mkdtemp(join(tmpdir(), "repair-refresh-"));
  const path = join(directory, "test.sqlite");
  const previous = { db: process.env.GARAGE_DB_PATH, secret: process.env.ONEC_REPAIRS_INTEGRATION_SECRET };
  process.env.GARAGE_DB_PATH = path; process.env.ONEC_REPAIRS_INTEGRATION_SECRET = secret;
  const auth = authenticated ? new UserAuthService(path, "Администратор", "test-admin-password") : undefined;
  const server = createAggregatorServer({ application: { streamSearch: async () => {}, listSupplierSessions: () => [] }, publicDir: resolve("src/frontend"), auth });
  try {
    await new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolvePromise); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const request = (path, options) => fetch(origin + path, options);
    const send = (card) => request("/api/integration/1c/repairs", { method: "POST", ...json(card, { Authorization: `Bearer ${secret}` }) });
    const poll = async (testPlatform = false) => {
      const response = await request(`/api/integration/1c/repairs/refresh/requests?testPlatform=${testPlatform}&waitSeconds=0`, { headers: { Authorization: `Bearer ${secret}` } });
      assert.equal(response.status, 200); return (await response.json()).request;
    };
    const create = (ids, testPlatform = false, cookie) => request(`/api/repairs/refresh?testPlatform=${testPlatform}`, { method: "POST", ...json({ documentIds: ids }, cookie ? { Cookie: cookie } : {}) });
    const result = (job, repairs = [], removedDocumentIds = [], extra = {}) => request("/api/integration/1c/repairs/refresh/results", { method: "POST", ...json({
      requestId: job.id, leaseId: job.leaseId, testPlatform: job.testPlatform, status: "success", repairs, removedDocumentIds, ...extra,
    }, { Authorization: `Bearer ${secret}` }) });
    const get = (job, cookie) => request(`/api/repairs/refresh/${job.id}?testPlatform=${job.testPlatform ?? false}`, { headers: cookie ? { Cookie: cookie } : {} });
    await check({ request, send, poll, create, result, get, path });
  } finally {
    server.closeAllConnections(); await new Promise((resolvePromise) => server.close(resolvePromise));
    for (const [key, value] of [["GARAGE_DB_PATH", previous.db], ["ONEC_REPAIRS_INTEGRATION_SECRET", previous.secret]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

test("repair refresh requires a live worker and updates only the requested orders after a complete reply", async () => {
  await withServer(async ({ request, send, poll, create, result, get }) => {
    await send(first); await send(second); await send({ ...first, testPlatform: true });
    assert.equal((await create([first.documentId])).status, 503);
    assert.equal(await poll(), null);
    assert.equal((await create([first.documentId], true)).status, 503);
    const created = await create([first.documentId]); assert.equal(created.status, 202);
    const pending = (await created.json()).refresh;
    assert.equal(pending.status, "pending");
    const job = await poll(); assert.deepEqual(job.documentIds, [first.documentId]);
    assert.equal(job.testPlatform, false);
    assert.equal((await create([second.documentId])).status, 429);
    const fresh = { ...first, vehicleName: "Проверено 1С", goodsReadiness: { totalPositions: 4, availablePositions: 4 }, paymentStatus: "paid" };
    assert.equal((await result(job, [fresh])).status, 200);
    const completed = (await (await get(job)).json()).refresh;
    assert.equal(completed.status, "completed"); assert.deepEqual(completed.repairs, [fresh]);
    const all = (await (await request("/api/repairs")).json()).repairs;
    assert.deepEqual(all.find((card) => card.documentId === second.documentId), second);
    assert.deepEqual(all.find((card) => card.testPlatform), { ...first, testPlatform: true });
    assert.deepEqual(all.find((card) => card.documentId === first.documentId && !card.testPlatform), fresh);
  });
});

test("partial, extra, malformed and failed repair replies never update even one cached card", async () => {
  await withServer(async ({ request, send, poll, create, result, get }) => {
    await send(first); await send(second); await poll();
    const updated = { ...first, vehicleName: "Нельзя применить частично" };
    for (const [repairs, removed, extra] of [
      [[updated], [], {}], [[updated, { ...second, goodsReadiness: { totalPositions: 1, availablePositions: 2 } }], [], {}],
      [[updated, { ...second, goodsReadiness: undefined }], [], {}], [[updated, second], [], { status: "error" }],
      [[updated, { ...second, paymentStatus: "invalid" }], [], {}],
      [[updated], [first.documentId], {}], [[updated, { ...second, documentId: "32345678-abcd-1234-abcd-123456789abc" }], [], {}],
      [[updated, { ...second, testPlatform: true }], [], {}], [[updated, second], [], { ignoredField: true }],
    ]) {
      assert.equal((await create([first.documentId, second.documentId])).status, 202);
      const job = await poll();
      assert.equal((await result(job, repairs, removed, extra)).status, 200);
      const response = (await (await get(job)).json()).refresh;
      assert.equal(response.status, "error"); assert.match(response.message, /Обратитесь в магазин/);
      assert.equal(response.repairs, undefined);
      assert.deepEqual((await (await request("/api/repairs")).json()).repairs, [first, second]);
    }
  });
});

test("confirmed removals are atomic and concurrent card changes reject the entire refresh", async () => {
  await withServer(async ({ request, send, poll, create, result, get }) => {
    await send(first); await send(second); await poll();
    await create([first.documentId, second.documentId]); const stale = await poll();
    const concurrent = { ...second, vehicleName: "Более новая карточка" }; await send(concurrent);
    await result(stale, [{ ...first, vehicleName: "Устаревший ответ" }], [second.documentId]);
    assert.equal((await (await get(stale)).json()).refresh.status, "error");
    assert.deepEqual((await (await request("/api/repairs")).json()).repairs, [first, concurrent]);
    await create([first.documentId, second.documentId]); const job = await poll();
    await result(job, [{ ...first, vehicleName: "Свежая карточка" }], [second.documentId]);
    assert.deepEqual((await (await get(job)).json()).refresh.removedDocumentIds, [second.documentId]);
    assert.deepEqual((await (await request("/api/repairs")).json()).repairs.map((card) => card.vehicleName), ["Свежая карточка"]);
  });
});

test("repair leases, cancellation, expiry and worker authorization reject late or unrelated results", async () => {
  await withServer(async ({ request, send, poll, create, result, get, path }) => {
    await send(first); await poll();
    assert.equal((await request("/api/integration/1c/repairs/refresh/requests?testPlatform=false&waitSeconds=0")).status, 401);
    await create([first.documentId]); const old = await poll();
    const db = new DatabaseSync(path);
    db.prepare("UPDATE repair_refresh_requests SET lease_until=? WHERE id=?").run(Date.now() - 1, old.id);
    const next = await poll(); assert.equal(next.id, old.id); assert.notEqual(next.leaseId, old.leaseId);
    assert.equal((await result(old, [first])).status, 409);
    assert.equal((await result(next, [first])).status, 200);
    assert.equal((await result(next, [first])).status, 200);
    assert.equal((await result(next, [{ ...first, vehicleName: "Другой ответ" }])).status, 409);
    await create([first.documentId]); const cancelled = await poll();
    assert.equal((await request(`/api/repairs/refresh/${cancelled.id}?testPlatform=false`, { method: "DELETE" })).status, 200);
    assert.equal((await result(cancelled, [first])).status, 409);
    assert.equal((await (await get(cancelled)).json()).refresh.status, "cancelled");
    await create([first.documentId]); const expired = await poll();
    db.prepare("UPDATE repair_refresh_requests SET expires_at=? WHERE id=?").run(Date.now() - 1, expired.id);
    assert.equal((await result(expired, [first])).status, 409);
    assert.equal((await (await get(expired)).json()).refresh.status, "expired");
    db.close();
  });
});

test("repair refresh enforces permissions, document responsibility and request ownership on the server", async () => {
  await withServer(async ({ request, send, poll, create, result, get }) => {
    const login = async (fio, password) => (await request("/api/auth/login", { method: "POST", ...json({ fio, password }) })).headers.get("set-cookie").split(";", 1)[0];
    const admin = await login("Администратор", "test-admin-password");
    for (const [fio, permissions] of [["Первый сотрудник", ["repairs"]], ["Второй сотрудник", ["repairs"]], ["Нет доступа", ["markup"]]]) {
      assert.equal((await request("/api/users", { method: "POST", ...json({ fio, permissions, password: "test-user-password" }, { Cookie: admin }) })).status, 201);
    }
    const one = await login("Первый сотрудник", "test-user-password"), two = await login("Второй сотрудник", "test-user-password"), denied = await login("Нет доступа", "test-user-password");
    await send(first); await send({ ...second, responsibleFio: "Второй сотрудник" }); await poll();
    assert.equal((await create([first.documentId], false, denied)).status, 403);
    assert.equal((await create([first.documentId], true, one)).status, 403);
    assert.equal((await create([second.documentId], false, one)).status, 404);
    const created = await create([first.documentId], false, one); assert.equal(created.status, 202);
    const job = await poll();
    assert.equal((await get(job, two)).status, 404);
    assert.equal((await get(job, admin)).status, 404);
    assert.equal((await request(`/api/repairs/refresh/${job.id}?testPlatform=false`, { method: "DELETE", headers: { Cookie: two } })).status, 404);
    await result(job, [{ ...first, responsibleFio: "Второй сотрудник" }]);
    const refreshed = (await (await get(job, one)).json()).refresh;
    assert.deepEqual(refreshed.repairs, []); assert.deepEqual(refreshed.removedDocumentIds, [first.documentId]);
    assert.equal(JSON.stringify(refreshed).includes("Второй сотрудник"), false);
  }, true);
});

test("repair refresh validates request bounds and mode without exposing the integration secret", async () => {
  await withServer(async ({ request, send, poll, create }) => {
    await send(first); await poll();
    for (const ids of [[], [first.documentId, first.documentId], Array(201).fill(first.documentId), ["invalid-id"], ["00000000-0000-0000-0000-000000000000"]]) {
      assert.equal((await create(ids)).status, 400);
    }
    assert.equal((await request("/api/repairs/refresh", { method: "POST", ...json({ documentIds: [first.documentId] }) })).status, 400);
    const bad = await request("/api/integration/1c/repairs/refresh/requests?testPlatform=false&waitSeconds=21", { headers: { Authorization: `Bearer ${secret}` } });
    assert.equal(bad.status, 400); assert.equal((await bad.text()).includes(secret), false);
  });
});

test("offline failures remain unverified across page reads and ordinary imports; only a complete refresh verifies them", async () => {
  await withServer(async ({ request, send, poll, create, result, get }) => {
    await send(first);
    assert.equal((await create([first.documentId])).status, 503);
    assert.deepEqual((await (await request("/api/repairs")).json()).unverified, [{ documentId: first.documentId, testPlatform: false }]);
    await send({ ...first, goodsReadiness: { totalPositions: 8, availablePositions: 8 } });
    assert.equal((await (await request("/api/repairs")).json()).unverified.length, 1);
    await poll(); await create([first.documentId]); const job = await poll();
    await result(job, [first]);
    assert.equal((await (await get(job)).json()).refresh.status, "completed");
    assert.equal((await (await request("/api/repairs")).json()).unverified, undefined);
    await send({ ...first, vehicleName: "Изменено после подтверждения" });
    assert.equal((await (await get(job)).json()).refresh.status, "error");
    assert.equal((await (await request("/api/repairs")).json()).unverified.length, 1);
  });
});
