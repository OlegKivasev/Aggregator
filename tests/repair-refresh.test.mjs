import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { RepairRefreshService } from "../src/backend/repairs/repair-refresh-service.ts";
import { UserAuthService } from "../src/backend/auth/user-auth-service.ts";
import { createAggregatorServer } from "../src/backend/http/create-server.ts";

const secret = "isolated-test-repair-refresh-secret-32-bytes";
const first = { documentId: "12345678-abcd-1234-abcd-123456789abc", number: "ТЕСТ-1", date: "2026-11-03T14:30:00",
  vehicleName: "Тестовая машина", status: "В работе", responsibleFio: "Первый сотрудник", goodsReadiness: { totalPositions: 3, availablePositions: 1 }, paymentStatus: "partially_paid", amountDue: 10_500.01 };
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
    const fresh = { ...first, vehicleName: "Проверено 1С", goodsReadiness: { totalPositions: 4, availablePositions: 4 }, paymentStatus: "paid", amountDue: 0 };
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
      [[updated, { ...second, amountDue: undefined }], [], {}], [[updated, { ...second, amountDue: -1 }], [], {}],
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

test("an administrator can confirm all 23 orders delivered concurrently by 1C while an employee sees only their own", async () => {
  await withServer(async ({ request, send, poll, create, result, get }) => {
    const login = async (fio, password) => (await request("/api/auth/login", { method: "POST", ...json({ fio, password }) })).headers.get("set-cookie").split(";", 1)[0];
    const admin = await login("Администратор", "test-admin-password");
    assert.equal((await request("/api/users", { method: "POST", ...json({ fio: "Первый сотрудник", permissions: ["repairs"], password: "test-user-password" }, { Cookie: admin }) })).status, 201);
    const employee = await login("Первый сотрудник", "test-user-password");
    const cards = [first, ...Array.from({ length: 22 }, (_, index) => ({ ...second,
      documentId: `${(index + 1).toString(16).padStart(8, "0")}-abcd-1234-abcd-123456789abc`,
      responsibleFio: "Второй сотрудник" }))];
    for (const card of cards) await send(card);
    await send({ ...first, testPlatform: true }); await poll();
    assert.equal((await create(cards.map((card) => card.documentId), false, admin)).status, 202);
    const job = await poll();
    assert.equal(job.documentIds.length, 23);
    const fresh = cards.map((card) => ({ ...card, goodsReadiness: { totalPositions: 6, availablePositions: 6 }, amountDue: 9_500.01 }));
    // The scheduled sender already delivered exactly the values read by the manual worker.
    for (const card of fresh) await send(card);
    assert.equal((await result(job, fresh)).status, 200);
    const completed = (await (await get(job, admin)).json()).refresh;
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.repairs, fresh);
    assert.equal((await (await request("/api/repairs", { headers: { Cookie: admin } })).json()).unverified, undefined);
    assert.deepEqual((await (await request("/api/repairs?testPlatform=true", { headers: { Cookie: admin } })).json()).repairs, [{ ...first, testPlatform: true }]);
    assert.deepEqual((await (await request("/api/repairs?testPlatform=false", { headers: { Cookie: employee } })).json()).repairs, [fresh[0]]);
    assert.equal((await create([first.documentId], false, employee)).status, 202);
    const employeeJob = await poll();
    assert.deepEqual(employeeJob.documentIds, [first.documentId]);
    await result(employeeJob, [fresh[0]]);
    assert.equal((await (await get(employeeJob, employee)).json()).refresh.status, "completed");
    const closedId = cards[1].documentId;
    await create([closedId], false, admin);
    const closingJob = await poll();
    assert.equal((await request("/api/integration/1c/repairs", { method: "DELETE",
      ...json({ documentId: closedId, testPlatform: false }, { Authorization: `Bearer ${secret}` }) })).status, 200);
    await result(closingJob, [], [closedId]);
    const closed = (await (await get(closingJob, admin)).json()).refresh;
    assert.equal(closed.status, "completed");
    assert.deepEqual(closed.removedDocumentIds, [closedId]);
  }, true);
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
    assert.equal((await request(`/api/repairs/refresh/${job.id}?testPlatform=false&waitSeconds=20`, { headers: { Cookie: two } })).status, 404);
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
    for (const query of ["waitSeconds=21", "waitSeconds=-1", "waitSeconds=1&waitSeconds=2", "testPlatform=false", "unknown=1"]) {
      assert.equal((await request(`/api/repairs/refresh/${first.documentId}?testPlatform=false&${query}`)).status, 400);
    }
    assert.equal((await request("/api/repairs?waitSeconds=1")).status, 400);
    assert.equal((await request("/api/repairs/refresh?testPlatform=false&waitSeconds=1", { method: "POST", ...json({ documentIds: [first.documentId] }) })).status, 400);
  });
});

test("browser long polls wake on a confirmed result or cancellation", async () => {
  await withServer(async ({ request, send, poll, create, result, get }) => {
    await send(first); await poll(); await create([first.documentId]);
    const job = await poll();
    const controller = new AbortController();
    let settled = false;
    const waiting = request(`/api/repairs/refresh/${job.id}?testPlatform=false&waitSeconds=20`, { signal: controller.signal })
      .then(async (response) => { settled = true; assert.equal(response.status, 200); return (await response.json()).refresh; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(settled, false, "a pending request must be held on the server");
      await result(job, [first]);
      assert.equal((await waiting).status, "completed");
      const started = performance.now();
      assert.equal((await (await request(`/api/repairs/refresh/${job.id}?testPlatform=false&waitSeconds=20`)).json()).refresh.status, "completed");
      assert.ok(performance.now() - started < 1000, "already completed results must not wait");
      await create([first.documentId]); const cancelled = await poll();
      const cancelledWait = request(`/api/repairs/refresh/${cancelled.id}?testPlatform=false&waitSeconds=20`, { signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 30));
      await request(`/api/repairs/refresh/${cancelled.id}?testPlatform=false`, { method: "DELETE" });
      assert.equal((await (await cancelledWait).json()).refresh.status, "cancelled");
      assert.equal((await (await get(cancelled)).json()).refresh.status, "cancelled");
    } finally { controller.abort(); }
  });
});

test("batch verification markers roll back together if a storage write fails", async () => {
  await withServer(async ({ request, send, poll, create, path }) => {
    await send(first); await send(second); await poll();
    const db = new DatabaseSync(path);
    try {
      db.exec(`CREATE TRIGGER fail_verification_marker BEFORE INSERT ON repair_refresh_unverified
        WHEN NEW.document_id='${second.documentId}' BEGIN SELECT RAISE(ABORT, 'test storage failure'); END`);
      assert.equal((await create([first.documentId, second.documentId])).status, 500);
      assert.equal((await (await request("/api/repairs")).json()).unverified, undefined);
      db.exec("DROP TRIGGER fail_verification_marker");
      assert.equal((await create([first.documentId, second.documentId])).status, 202);
      assert.equal((await (await request("/api/repairs")).json()).unverified.length, 2);
    } finally { db.close(); }
  });
});

test("browser waits release capacity on disconnect and shutdown without cancelling the refresh", async () => {
  const db = new DatabaseSync(":memory:");
  const refreshes = new RepairRefreshService(db, () => [first], () => "version", () => {});
  const disconnect = new AbortController();
  try {
    refreshes.claim(false);
    const job = refreshes.create({ documentIds: [first.documentId] }, false, "owner");
    const wait = (signal) => refreshes.getWhenReady(job.id, false, "owner", undefined, signal, 20_000);
    const waiting = Array.from({ length: 100 }, () => wait(disconnect.signal));
    await assert.rejects(wait(disconnect.signal), { statusCode: 429 });
    disconnect.abort();
    assert.ok((await Promise.all(waiting)).every((result) => result.status === "pending"));
    assert.equal(refreshes.get(job.id, false, "owner").status, "pending");
    const afterDisconnect = wait(new AbortController().signal);
    refreshes.cancel(job.id, false, "owner");
    assert.equal((await afterDisconnect).status, "cancelled");
    const next = refreshes.create({ documentIds: [first.documentId] }, false, "owner");
    const stopping = refreshes.getWhenReady(next.id, false, "owner", undefined, new AbortController().signal, 20_000);
    refreshes.close();
    assert.equal((await stopping).status, "pending");
  } finally { disconnect.abort(); refreshes.close(); db.close(); }
});

test("refresh timing separates waiting for 1C from reading and sending the result without mixing client clocks", () => {
  const db = new DatabaseSync(":memory:");
  let now = 1_000_000;
  const refreshes = new RepairRefreshService(db, () => [first], () => "version", () => {}, () => now);
  try {
    refreshes.claim(false);
    refreshes.create({ documentIds: [first.documentId] }, false, "owner");
    now += 2300;
    const job = refreshes.claim(false);
    now += 5100;
    const result = refreshes.complete({ requestId: job.id, leaseId: job.leaseId, testPlatform: false,
      status: "success", repairs: [first], removedDocumentIds: [] });
    assert.equal(result.status, "completed");
    assert.equal(result.timing.queueMs, 2300);
    assert.equal(result.timing.workerMs, 5100);
    assert.ok(Number.isInteger(result.timing.applyMs) && result.timing.applyMs >= 0);
  } finally { refreshes.close(); db.close(); }
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
