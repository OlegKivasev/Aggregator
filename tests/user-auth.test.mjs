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
    const created = await fetch(`${baseUrl}/api/users`, {
      method: "POST", headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ fio: "Иванов Иван Иванович", password: "user-password-123", permissions: ["repairs"] }),
    });
    assert.equal(created.status, 201);

    const put = async (documentId, responsibleFio) => fetch(`${baseUrl}/api/integration/1c/repairs`, {
      method: "POST", headers: { Authorization: `Bearer ${integrationSecret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ documentId, number: documentId, date: "2026-11-09T10:00:00", vehicleName: "Автомобиль", status: "В работе", responsibleFio }),
    });
    assert.equal((await put("12345678-abcd-1234-abcd-123456789abc", "Иванов Иван Иванович")).status, 200);
    assert.equal((await put("12345678-abcd-1234-abcd-123456789abd", "Петров Петр Петрович")).status, 200);

    const userCookie = await login(baseUrl, "Иванов Иван Иванович", "user-password-123");
    const repairs = await fetch(`${baseUrl}/api/repairs`, { headers: { Cookie: userCookie } });
    assert.equal(repairs.status, 200);
    assert.deepEqual((await repairs.json()).repairs.map((repair) => repair.responsibleFio), ["Иванов Иван Иванович"]);
    assert.equal((await fetch(`${baseUrl}/api/applicability/saved-articles`, { headers: { Cookie: userCookie } })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/users`, { headers: { Cookie: userCookie } })).status, 403);
  });
});
