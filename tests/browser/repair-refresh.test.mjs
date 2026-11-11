import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { createAggregatorServer } from "../../src/backend/http/create-server.ts";

const secret = "browser-refresh-test-only-repair-secret-32";
const first = { documentId: "12345678-abcd-1234-abcd-123456789abc", number: "ТЕСТ-1", date: "2026-11-03T14:30:00",
  vehicleName: "Toyota Camry | А123ВС163", status: "В работе", goodsReadiness: { totalPositions: 3, availablePositions: 1 }, paymentStatus: "partially_paid", amountDue: 10_500 };
const second = { ...first, documentId: "22345678-abcd-1234-abcd-123456789abc", vehicleName: "Ford Focus" };

test("refresh reads only visible orders from 1C, animates, hides uncertain data through reload and recovers after a verified reply", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "repair-refresh-browser-"));
  const previousPath = process.env.GARAGE_DB_PATH, previousSecret = process.env.ONEC_REPAIRS_INTEGRATION_SECRET;
  process.env.GARAGE_DB_PATH = join(directory, "test.sqlite"); process.env.ONEC_REPAIRS_INTEGRATION_SECRET = secret;
  const server = createAggregatorServer({ application: { streamSearch: async () => {} }, publicDir: resolve("src/frontend") });
  let browser;
  try {
    await new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolvePromise); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const request = (path, options) => fetch(origin + path, options);
    const headers = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };
    const send = async (card) => { assert.equal((await request("/api/integration/1c/repairs", { method: "POST", headers, body: JSON.stringify(card) })).status, 200); };
    const poll = async (wait = 0) => {
      const response = await request(`/api/integration/1c/repairs/refresh/requests?testPlatform=false&waitSeconds=${wait}`, { headers });
      assert.equal(response.status, 200); return (await response.json()).request;
    };
    const complete = async (job, repairs, removedDocumentIds = []) => {
      assert.equal((await request("/api/integration/1c/repairs/refresh/results", { method: "POST", headers,
        body: JSON.stringify({ requestId: job.id, leaseId: job.leaseId, testPlatform: false, status: "success", repairs, removedDocumentIds }) })).status, 200);
    };
    await send(first); await send(second); await send({ ...first, testPlatform: true }); await poll();
    browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_BROWSER_EXECUTABLE_PATH });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith("/api/") || url.pathname.startsWith("/api/repairs")) return route.continue();
      const responses = { "/api/auth/session": { enabled: false, user: null }, "/api/suppliers/sessions": { sessions: [] },
        "/api/applicability/api-key": { configured: false }, "/api/applicability/proxies": { persistent: false, proxies: [], activeRouteId: null, directUsage: {}, usage: {} },
        "/api/garage/vehicles": { vehicles: [] }, "/api/nomenclature/connection": { configured: false, online: false, lastSeenAt: null } };
      return route.fulfill({ json: responses[url.pathname] ?? { articles: [], brandCounts: [], hasMore: false } });
    });
    await page.goto(origin); await page.locator("#repairs-function-tab").click();
    await page.locator("#repairs-rows .repairs-readiness").first().waitFor();
    await page.locator("#repairs-search").fill("Toyota");
    // A fresh result must render even while browser timers are stopped.
    // This catches reintroducing a fixed delay before requesting the result.
    await page.clock.install({ time: new Date("2026-11-11T12:00:00Z") });
    await page.clock.pauseAt(new Date("2026-11-11T12:00:01Z"));
    const claimed = poll(20);
    const awaitingResult = page.waitForRequest((request) => request.method() === "GET"
      && /\/api\/repairs\/refresh\//.test(request.url()) && new URL(request.url()).searchParams.get("waitSeconds") === "20");
    await page.locator("#repairs-refresh").click();
    const job = await claimed;
    await awaitingResult;
    assert.deepEqual(job.documentIds, [first.documentId]);
    assert.equal(job.testPlatform, false);
    const progress = page.locator("#repairs-feedback");
    assert.equal(await progress.textContent(), "Обновляем данные из 1С…");
    assert.equal(await page.locator("#repairs-function").getAttribute("aria-busy"), "true");
    assert.equal(await page.locator("#repairs-refresh").isDisabled(), true);
    assert.equal(await page.locator("#repairs-search").isDisabled(), true);
    assert.equal(await page.locator("#repairs-rows .repairs-readiness").count(), 0);
    assert.equal(await page.locator("#repairs-rows .repairs-payment-detail").count(), 0);
    assert.equal(await progress.evaluate((element) => getComputedStyle(element, "::before").animationName), "search-loading-spin");
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await progress.evaluate((element) => getComputedStyle(element, "::before").animationName), "none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    assert.equal(await page.locator("#repairs-function").evaluate((element) => element.scrollWidth <= element.clientWidth), true);
    if (process.env.REPAIRS_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.REPAIRS_SCREENSHOT_DIR, "repair-refresh-mobile.png"), fullPage: true });
    const fresh = { ...first, goodsReadiness: { totalPositions: 4, availablePositions: 4 }, paymentStatus: "paid", amountDue: 0 };
    const deliveryStarted = performance.now();
    await complete(job, [fresh]);
    await page.locator("#repairs-rows").getByText("В наличии 4 из 4 позиций", { exact: true }).waitFor();
    t.diagnostic(`Local worker result to rendered cards: ${Math.round(performance.now() - deliveryStarted)} ms (browser timers paused)`);
    await page.clock.resume();
    assert.equal(await page.locator("#repairs-rows .repairs-payment").textContent(), "Оплачен");
    assert.equal(await page.locator("#repairs-rows .repairs-payment-detail").count(), 0);
    assert.equal(await page.locator("#repairs-search").inputValue(), "Toyota");
    assert.equal(await page.locator("#repairs-refresh").isEnabled(), true);
    const stored = (await (await request("/api/repairs?testPlatform=false")).json()).repairs;
    assert.deepEqual(stored.find((card) => card.documentId === second.documentId), second);

    const next = poll(20); await page.locator("#repairs-refresh").click();
    const broken = await next;
    await complete(broken, []); // Incomplete reply must never become an empty successful list.
    await progress.getByText(/Произошёл сбой обновления.*Обратитесь в магазин/).waitFor();
    assert.equal(await page.locator("#repairs-rows .repairs-readiness").count(), 0);
    assert.equal(await page.locator("#repairs-count").isVisible(), false);
    await page.reload();
    await page.locator("#repairs-feedback").getByText(/Произошёл сбой обновления.*Обратитесь в магазин/).waitFor();
    assert.equal(await page.locator("#repairs-rows .repairs-readiness").count(), 0);
    await page.locator("#repairs-search").fill("");
    const retry = poll(20); await page.locator("#repairs-refresh").click();
    const recovered = await retry; assert.deepEqual(new Set(recovered.documentIds), new Set([first.documentId, second.documentId]));
    await complete(recovered, [fresh, second]);
    await page.locator("#repairs-rows").getByText("В наличии 4 из 4 позиций", { exact: true }).waitFor();
    assert.equal((await (await request("/api/repairs")).json()).unverified, undefined);

    // Verifying a filtered subset cannot restore uncertain orders outside that filter.
    const all = poll(20); await page.locator("#repairs-refresh").click();
    await complete(await all, []);
    await progress.getByText(/Произошёл сбой обновления/).waitFor();
    await page.locator("#repairs-search").fill("Toyota");
    const subset = poll(20); await page.locator("#repairs-refresh").click();
    const subsetJob = await subset;
    assert.deepEqual(subsetJob.documentIds, [first.documentId]);
    await complete(subsetJob, [fresh]);
    await page.locator("#repairs-rows").getByText("В наличии 4 из 4 позиций", { exact: true }).waitFor();
    await page.locator("#repairs-search").fill("");
    await progress.getByText(/Произошёл сбой обновления/).waitFor();
    assert.equal(await page.locator("#repairs-rows .repairs-readiness").count(), 0);
    await page.reload();
    await progress.getByText(/Произошёл сбой обновления/).waitFor();
    await page.locator("#repairs-search").fill("Ford");
    const other = poll(20); await page.locator("#repairs-refresh").click();
    const otherJob = await other; assert.deepEqual(otherJob.documentIds, [second.documentId]);
    await complete(otherJob, [second]);
    await page.locator("#repairs-rows .repairs-readiness").waitFor();
    await page.locator("#repairs-search").fill("");
    assert.equal(await page.locator("#repairs-rows .repairs-readiness").count(), 2);
    assert.equal((await (await request("/api/repairs")).json()).unverified, undefined);

    // If the POST never reaches the server, this tab must still hide unconfirmed data after reload.
    await page.locator("#repairs-search").fill("Toyota");
    await page.route("**/api/repairs/refresh?*", (route) => route.request().method() === "POST" ? route.abort() : route.continue());
    await page.locator("#repairs-refresh").click();
    await progress.getByText(/Произошёл сбой обновления/).waitFor();
    assert.equal((await (await request("/api/repairs")).json()).unverified, undefined);
    await page.reload();
    await progress.getByText(/Произошёл сбой обновления/).waitFor();
    assert.equal(await page.locator("#repairs-rows .repairs-readiness").count(), 0);
    await page.locator("#repairs-search").fill("Ford");
    await page.locator("#repairs-rows .repairs-readiness").waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); server.closeAllConnections(); await new Promise((resolvePromise) => server.close(resolvePromise));
    if (previousPath === undefined) delete process.env.GARAGE_DB_PATH; else process.env.GARAGE_DB_PATH = previousPath;
    if (previousSecret === undefined) delete process.env.ONEC_REPAIRS_INTEGRATION_SECRET; else process.env.ONEC_REPAIRS_INTEGRATION_SECRET = previousSecret;
    await rm(directory, { recursive: true, force: true });
  }
});
