import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { UserAuthService } from "../src/backend/auth/user-auth-service.ts";
import { createAggregatorServer } from "../src/backend/http/create-server.ts";

const integrationSecret = "user-auth-test-integration-secret-32-bytes";

async function withServer(check) {
  const directory = await mkdtemp(join(tmpdir(), "aggregator-user-auth-"));
  const previousPath = process.env.GARAGE_DB_PATH;
  const previousSecret = process.env.ONEC_REPAIRS_INTEGRATION_SECRET;
  process.env.GARAGE_DB_PATH = join(directory, "garage.sqlite");
  process.env.ONEC_REPAIRS_INTEGRATION_SECRET = integrationSecret;
  const auth = new UserAuthService(process.env.GARAGE_DB_PATH, "Администратор", "admin-password-123");
  const server = createAggregatorServer({
    application: { streamSearch: async () => {}, listSupplierSessions: () => [] },
    publicDir: resolve("src/frontend"), auth,
  });
  await new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolvePromise); });
  try {
    await check(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolvePromise) => server.close(resolvePromise));
    if (previousPath === undefined) delete process.env.GARAGE_DB_PATH; else process.env.GARAGE_DB_PATH = previousPath;
    if (previousSecret === undefined) delete process.env.ONEC_REPAIRS_INTEGRATION_SECRET; else process.env.ONEC_REPAIRS_INTEGRATION_SECRET = previousSecret;
    await rm(directory, { recursive: true, force: true });
  }
}

async function login(baseUrl, fio, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fio, password }),
  });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";", 1)[0];
}

test("default administrator creates a restricted user and repair cards are filtered by responsible FIO", async () => {
  await withServer(async (baseUrl) => {
    const adminCookie = await login(baseUrl, "Администратор", "admin-password-123");
    const restartedAuth = new UserAuthService(process.env.GARAGE_DB_PATH, "Администратор", "admin-password-123");
    try {
      const restored = restartedAuth.currentUser({ headers: { cookie: adminCookie } });
      assert.equal(restored?.fio, "Администратор");
    } finally {
      restartedAuth.close();
    }
    const created = await fetch(`${baseUrl}/api/users`, {
      method: "POST", headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ fio: "Иванов Иван Иванович", password: "user-password-123", permissions: ["repairs"] }),
    });
    assert.equal(created.status, 201);
    const testCreated = await fetch(`${baseUrl}/api/users`, {
      method: "POST", headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ fio: "Тестовый Пользователь", password: "test-password-123", permissions: ["testRepairs"] }),
    });
    assert.equal(testCreated.status, 201);
    const loginUsers = await fetch(`${baseUrl}/api/auth/users`);
    assert.equal(loginUsers.status, 200);
    assert.deepEqual((await loginUsers.json()).users, [
      { fio: "Иванов Иван Иванович" },
      { fio: "Тестовый Пользователь" },
    ]);

    const put = async (documentId, responsibleFio) => fetch(`${baseUrl}/api/integration/1c/repairs`, {
      method: "POST", headers: { Authorization: `Bearer ${integrationSecret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ documentId, number: documentId, date: "2026-11-09T10:00:00", vehicleName: "Автомобиль", status: "В работе", responsibleFio }),
    });
    assert.equal((await put("12345678-abcd-1234-abcd-123456789abc", "Иванов Иван Иванович")).status, 200);
    assert.equal((await put("12345678-abcd-1234-abcd-123456789abd", "Петров Петр Петрович")).status, 200);

    const userCookie = await login(baseUrl, "Иванов Иван Иванович", "user-password-123");
    const repairs = await fetch(`${baseUrl}/api/repairs?testPlatform=false`, { headers: { Cookie: userCookie } });
    assert.equal(repairs.status, 200);
    assert.deepEqual((await repairs.json()).repairs.map((repair) => repair.responsibleFio), ["Иванов Иван Иванович"]);
    assert.equal((await fetch(`${baseUrl}/api/repairs?testPlatform=true`, { headers: { Cookie: userCookie } })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/repairs`, { headers: { Cookie: userCookie } })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/applicability/saved-articles`, { headers: { Cookie: userCookie } })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/users`, { headers: { Cookie: userCookie } })).status, 403);

    const testCookie = await login(baseUrl, "Тестовый Пользователь", "test-password-123");
    assert.equal((await fetch(`${baseUrl}/api/repairs?testPlatform=false`, { headers: { Cookie: testCookie } })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/repairs?testPlatform=true`, { headers: { Cookie: testCookie } })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/repairs`, { headers: { Cookie: testCookie } })).status, 403);

    const allRepairs = await fetch(`${baseUrl}/api/repairs`, { headers: { Cookie: adminCookie } });
    assert.equal(allRepairs.status, 200);
    assert.equal((await allRepairs.json()).repairs.length, 2);
  });
});

test("serves the login page before authentication while protecting API routes", async () => {
  await withServer(async (baseUrl) => {
    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="auth-screen"/);

    const protectedResponse = await fetch(`${baseUrl}/api/repairs`);
    assert.equal(protectedResponse.status, 401);
  });
});

test("only admins can persist a complete user order; invalid or stale orders leave it intact", async () => {
  await withServer(async (baseUrl) => {
    const cookie = await login(baseUrl, "Администратор", "admin-password-123");
    const headers = { Cookie: cookie, "Content-Type": "application/json" };
    const create = async (fio) => {
      const response = await fetch(`${baseUrl}/api/users`, { method: "POST", headers,
        body: JSON.stringify({ fio, password: "order-test-password", permissions: ["repairs"] }) });
      assert.equal(response.status, 201);
      return (await response.json()).user;
    };
    const alpha = await create("Альфа Сотрудник");
    const beta = await create("Бета Сотрудник");
    const list = async () => (await (await fetch(`${baseUrl}/api/users`, { headers })).json()).users;
    const initial = await list();
    const admin = initial.find((user) => user.isAdmin);
    assert.deepEqual(initial.map((user) => user.id), [admin.id, alpha.id, beta.id]);
    const ids = [beta.id, alpha.id, admin.id];
    const put = (payload, customHeaders = headers) => fetch(`${baseUrl}/api/users/order`, {
      method: "PUT", headers: customHeaders, body: JSON.stringify(payload),
    });
    assert.equal((await put({ userIds: ids }, { "Content-Type": "application/json" })).status, 401);
    const employeeCookie = await login(baseUrl, alpha.fio, "order-test-password");
    assert.equal((await put({ userIds: ids }, { Cookie: employeeCookie, "Content-Type": "application/json" })).status, 403);
    assert.equal((await put({ userIds: ids })).status, 200);
    assert.deepEqual((await list()).map((user) => user.id), ids);
    for (const [payload, status] of [[null, 400], [{}, 400], [{ userIds: "invalid" }, 400],
      [{ userIds: [alpha.id, alpha.id, admin.id] }, 400], [{ userIds: [alpha.id, 1, admin.id] }, 400],
      [{ userIds: [alpha.id] }, 409], [{ userIds: [beta.id, alpha.id, "unknown-user"] }, 409]]) {
      assert.equal((await put(payload)).status, status);
      assert.deepEqual((await list()).map((user) => user.id), ids);
    }
    assert.equal((await fetch(`${baseUrl}/api/users/order`, { headers })).status, 405);
    const restartedAuth = new UserAuthService(process.env.GARAGE_DB_PATH, "Администратор", "admin-password-123");
    const restartedServer = createAggregatorServer({ application: { streamSearch: async () => {}, listSupplierSessions: () => [] },
      publicDir: resolve("src/frontend"), auth: restartedAuth });
    try {
      await new Promise((resolvePromise, reject) => { restartedServer.once("error", reject); restartedServer.listen(0, "127.0.0.1", resolvePromise); });
      const response = await fetch(`http://127.0.0.1:${restartedServer.address().port}/api/users`, { headers });
      assert.deepEqual((await response.json()).users.map((user) => user.id), ids);
    } finally {
      restartedServer.closeAllConnections();
      await new Promise((resolvePromise) => restartedServer.close(resolvePromise));
    }
    const added = await create("А Новый сотрудник");
    assert.deepEqual((await list()).map((user) => user.id), [...ids, added.id]);
    assert.equal((await put({ userIds: ids })).status, 409);
    const removed = await fetch(`${baseUrl}/api/users`, { method: "DELETE", headers, body: JSON.stringify({ id: alpha.id }) });
    assert.equal(removed.status, 204);
    assert.deepEqual((await list()).map((user) => user.id), [beta.id, admin.id, added.id]);
    const suggestions = await (await fetch(`${baseUrl}/api/auth/users`)).json();
    assert.deepEqual(suggestions.users.map((user) => user.fio), [beta.fio, added.fio]);
  });
});
