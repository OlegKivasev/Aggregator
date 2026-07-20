import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import { findPrimaryPartKomMakerId } from "../src/backend/suppliers/part-kom/part-kom-api-adapter.ts";

const port = 31847;
const baseUrl = `http://127.0.0.1:${port}`;

test("Part-Kom selects the primary autocomplete maker for the requested normalized article", () => {
  const makerId = findPrimaryPartKomMakerId([
    { maker_id: 10, number: "VAP-021-2375", maker: "ВОЛГААВТОПРОМ" },
    { maker_id: 20, number: "VAP0212375", maker: "Россия" },
    { maker_id: 30, number: "VAP-021-2375A", maker: "RUSSIA" },
    { maker_id: 40, number: "VAP-021-237", maker: "RUSSIA" },
    { maker_id: 50, number: undefined, maker: "RUSSIA" },
  ], "VAP0212375");

  assert.equal(makerId, "10");
});

async function waitForServer(server) {
  const timeout = AbortSignal.timeout(10_000);

  while (!timeout.aborted) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: timeout });
      if (response.ok) {
        return;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  throw new Error("Server did not become ready within 10 seconds");
}

function requestWithHost(host) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path: "/api/health", headers: { Host: host } }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end();
  });
}

test("server production smoke test", async () => {
  const server = spawn(process.execPath, ["--experimental-strip-types", "src/backend/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    await waitForServer(server);

    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await requestWithHost("["), 200);

    const index = await fetch(`${baseUrl}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(await index.text(), /<!DOCTYPE html>/i);

    const oversizedBody = await fetch(`${baseUrl}/api/suppliers/rossko/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(17_000),
    });
    assert.equal(oversizedBody.status, 413);
    assert.deepEqual(await oversizedBody.json(), { message: "Request body is too large" });

    const traversal = await fetch(`${baseUrl}/%2e%2e/package.json`);
    assert.equal(traversal.status, 404);
  } finally {
    server.kill("SIGTERM");
    await once(server, "exit");
  }

  assert.equal(stderr, "");
});
