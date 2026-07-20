import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import { armtekEtpCandidateIds, parseArmtekDeliveryDates } from "../src/backend/suppliers/armtek/armtek-api-adapter.ts";
import { findPrimaryPartKomMakerId } from "../src/backend/suppliers/part-kom/part-kom-api-adapter.ts";
import { parseStpartsResults } from "../src/backend/suppliers/stparts/stparts-api-adapter.ts";
import { runSupplierSearch } from "../src/backend/suppliers/run-supplier-search.ts";
import { SupplierAuthError } from "../src/backend/suppliers/errors.ts";
import { SupplierSessionManager } from "../src/backend/session/session-manager.ts";
import { buildIncompleteSearchWarnings, buildSupplierResultTooltip } from "../src/frontend/supplier-search-summary.js";

const port = 31847;
const baseUrl = `http://127.0.0.1:${port}`;

test("Armtek includes every ambiguous brand candidate", () => {
  const ids = armtekEtpCandidateIds({
    data: {
      TBL: {
        FIRSTDATA: Array.from({ length: 14 }, (_, index) => ({ ARTID: String(index + 1) })),
      },
    },
  });

  assert.deepEqual(ids, Array.from({ length: 14 }, (_, index) => String(index + 1)));
});

test("Armtek keeps both delivery interval dates", () => {
  const dates = parseArmtekDeliveryDates("20260725", "20260728");

  assert.ok(dates.deliveryDate);
  assert.ok(dates.deliveryDateTo);
  assert.ok(Date.parse(dates.deliveryDate) < Date.parse(dates.deliveryDateTo));
  assert.equal(new Date(dates.deliveryDate).getDate(), 25);
  assert.equal(new Date(dates.deliveryDateTo).getDate(), 28);
});

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

test("STParts parses the supplier output price from current result rows", () => {
  const results = parseStpartsResults(`
    <tr class="resultTr2" data-is-request-article="1" data-output-price="6900.27" data-availability="38">
      <td class="resultBrand">ВолгаАвтоПром</td>
      <td class="resultDescription">ВАЛ КАРДАННЫЙ ВАЗ-2121 ЗАДНИЙ</td>
      <td class="resultWarehouse"><font color="green">POS1066</font></td>
    </tr>
  `, "VAP-021-2375", "https://stparts.ru/search/ВолгаАвтоПром/VAP0212375");

  assert.equal(results.length, 1);
  assert.equal(results[0].price, 6900.27);
  assert.equal(results[0].warehouse, "POS1066");
});

test("supplier authentication failure triggers session disconnection", async () => {
  const sessionManager = new SupplierSessionManager();
  sessionManager.markAuthorized("stparts");
  let disconnected = false;
  const events = [];
  const adapter = {
    id: "stparts",
    displayName: "STParts",
    timeoutMs: 1000,
    async ensureSession() {
      return sessionManager.getSession("stparts");
    },
    async search() {
      throw new SupplierAuthError("expired");
    },
  };

  await runSupplierSearch({
    adapter,
    sessionManager,
    query: { article: "TEST-1" },
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
    onAuthError: () => {
      disconnected = true;
    },
  });

  assert.equal(disconnected, true);
  assert.equal(events.at(-1).status, "auth_error");
});

test("incomplete search warnings list only failed suppliers", () => {
  assert.deepEqual(buildIncompleteSearchWarnings(
    ["rossko", "armtek", "part-kom", "stparts", "motordetal", "mladov"],
    {
      rossko: "completed",
      armtek: "completed",
      "part-kom": "timeout",
      stparts: "auth_error",
      motordetal: "error",
    },
    { rossko: "Rossko", armtek: "Armtek", "part-kom": "Part-Kom", stparts: "STParts", motordetal: "MotorDetal", mladov: "Механик Ладов" },
  ), [
    "Part-Kom: время ожидания истекло",
    "STParts: требуется авторизация",
    "MotorDetal: поиск не выполнен",
    "Механик Ладов: нет итогового ответа",
  ]);
});

test("supplier result tooltip includes duration for every selected supplier", () => {
  assert.equal(buildSupplierResultTooltip(
    ["rossko", "armtek"],
    [{ supplier: "rossko" }, { supplier: "rossko" }],
    { rossko: 38_200, armtek: 1_000 },
    { rossko: "Rossko", armtek: "Armtek" },
  ), "Rossko: 2 позиций (38,2 с)\nArmtek: 0 позиций (1,0 с)");
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

    const malformedValidation = await fetch(`${baseUrl}/api/suppliers/sessions/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ article: "TEST-1", suppliers: ["unknown"] }),
    });
    assert.equal(malformedValidation.status, 400);
    assert.deepEqual(await malformedValidation.json(), { message: "suppliers must contain supported supplier IDs" });

    const traversal = await fetch(`${baseUrl}/%2e%2e/package.json`);
    assert.equal(traversal.status, 404);
  } finally {
    server.kill("SIGTERM");
    await once(server, "exit");
  }

  assert.equal(stderr, "");
});
