import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const supplierEnvironmentVariables = [
  "ARMTEK_LOGIN",
  "ARMTEK_PASSWORD",
  "PARTKOM_LOGIN",
  "PARTKOM_PASSWORD",
  "STPARTS_API_LOGIN",
  "STPARTS_API_PASSWORD",
  "MOTORDETAL_LOGIN",
  "MOTORDETAL_PASSWORD",
  "MLADOV_LOGIN",
  "MLADOV_PASSWORD",
];

let baseUrl;
let child;
let stateDir;
let stderr = "";

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.notEqual(typeof address, "string");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForServer(url) {
  const timeout = AbortSignal.timeout(10_000);

  while (!timeout.aborted) {
    try {
      const response = await fetch(`${url}/api/health`, { signal: timeout });
      if (response.ok) {
        return;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  throw new Error("Server did not become ready within 10 seconds");
}

function parseSseEvents(body) {
  return body
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      assert.match(block, /^data: /);
      return JSON.parse(block.slice("data: ".length));
    });
}

before(async () => {
  const port = await reservePort();
  stateDir = await mkdtemp(join(tmpdir(), "autoservice-http-contract-"));
  const env = { ...process.env, PORT: String(port), STATE_DIR: stateDir };
  for (const variable of supplierEnvironmentVariables) {
    delete env[variable];
  }

  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["src/backend/server.ts"], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  await waitForServer(baseUrl);
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  if (stateDir) {
    await rm(stateDir, { recursive: true, force: true });
  }
  assert.equal(stderr, "");
});

test("HTTP routes preserve response and security contracts", async () => {
  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  assert.equal(health.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(health.headers.get("referrer-policy"), "no-referrer");
  assert.equal(health.headers.get("x-content-type-options"), "nosniff");
  assert.equal(health.headers.get("x-frame-options"), "DENY");

  const sessions = await fetch(`${baseUrl}/api/suppliers/sessions`);
  assert.equal(sessions.status, 200);
  const sessionPayload = await sessions.json();
  assert.deepEqual(sessionPayload.sessions.map((session) => session.supplier), [
    "rossko",
    "armtek",
    "part-kom",
    "stparts",
    "motordetal",
    "mladov",
  ]);
  assert.ok(sessionPayload.sessions.every((session) => session.authorized === false));

  const missing = await fetch(`${baseUrl}/api/not-found`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { message: "Not found" });

  const wrongMethod = await fetch(`${baseUrl}/api/health`, { method: "POST" });
  assert.equal(wrongMethod.status, 405);
  assert.deepEqual(await wrongMethod.json(), { message: "Method not allowed" });
});

test("JSON endpoints reject malformed and incomplete requests", async () => {
  const malformedJson = await fetch(`${baseUrl}/api/suppliers/rossko/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(malformedJson.status, 400);
  assert.deepEqual(await malformedJson.json(), { message: "Invalid JSON request body" });

  for (const supplier of ["rossko", "armtek", "part-kom", "stparts", "motordetal", "mladov"]) {
    const missingCredentials = await fetch(`${baseUrl}/api/suppliers/${supplier}/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: "" }),
    });
    assert.equal(missingCredentials.status, 400);
    assert.deepEqual(await missingCredentials.json(), { message: "login and password are required" });
  }

  const invalidCredentialTypes = await fetch(`${baseUrl}/api/suppliers/armtek/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: {}, password: [] }),
  });
  assert.equal(invalidCredentialTypes.status, 400);
  assert.deepEqual(await invalidCredentialTypes.json(), {
    message: "login and password must be strings within the allowed length",
  });

  const invalidValidation = await fetch(`${baseUrl}/api/suppliers/sessions/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ article: "ABC-123", suppliers: ["unknown"] }),
  });
  assert.equal(invalidValidation.status, 400);
  assert.deepEqual(await invalidValidation.json(), { message: "suppliers must contain supported supplier IDs" });
});

test("search endpoint preserves validation and non-stream behavior", async () => {
  const nonStream = await fetch(`${baseUrl}/api/search?article=ABC-123`);
  assert.equal(nonStream.status, 204);
  assert.equal(await nonStream.text(), "");

  const missingArticle = await fetch(`${baseUrl}/api/search?stream=once`);
  assert.equal(missingArticle.status, 400);
  assert.deepEqual(await missingArticle.json(), { message: "Query parameter article is required" });

  const oversizedArticle = await fetch(`${baseUrl}/api/search?stream=once&article=${"a".repeat(129)}`);
  assert.equal(oversizedArticle.status, 400);
  assert.deepEqual(await oversizedArticle.json(), { message: "Query parameter article must not exceed 128 characters" });
});

test("search streams a complete auth-error lifecycle for an unconfigured supplier", async () => {
  const response = await fetch(`${baseUrl}/api/search?stream=once&article=ABC-123&supplier=part-kom`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-cache, no-transform");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");

  assert.deepEqual(parseSseEvents(await response.text()), [
    { type: "search_started", article: "ABC-123", suppliers: ["part-kom"] },
    { type: "supplier_status", supplier: "part-kom", status: "searching" },
    { type: "supplier_status", supplier: "part-kom", status: "auth_error", details: "Supplier authorization is required" },
    { type: "search_completed", article: "ABC-123" },
  ]);
});

test("session validation deduplicates suppliers and reports expired sessions", async () => {
  const response = await fetch(`${baseUrl}/api/suppliers/sessions/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ article: "ABC-123", suppliers: ["part-kom", "part-kom"] }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.results, [{ supplier: "part-kom", status: "expired" }]);
  assert.equal(payload.sessions.find((session) => session.supplier === "part-kom").authorized, false);
});

test("supplier logout routes are idempotent", async () => {
  for (const supplier of ["rossko", "armtek", "part-kom", "stparts", "motordetal", "mladov"]) {
    const response = await fetch(`${baseUrl}/api/suppliers/${supplier}/logout`, { method: "POST" });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.session.supplier, supplier);
    assert.equal(payload.session.authorized, false);
  }
});
