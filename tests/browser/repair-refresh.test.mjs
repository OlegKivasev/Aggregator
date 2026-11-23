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

test("the all-open repair list has independent columns and status highlights, and refreshes 201 rows in two jobs", async (t) => {
  const server = createAggregatorServer({ application: { streamSearch: async () => {} }, publicDir: resolve("src/frontend") });
  const cards = Array.from({ length: 201 }, (_, index) => ({
    ...first, documentId: `12345678-abcd-1234-abcd-${String(index + 1).padStart(12, "0")}`,
    number: `НАРЯД-${index + 1}`, status: ["Готов к проверке", "Обратить внимание"][index] ?? "В работе",
    vehicleName: index < 3 ? ["Сигнал Toyota Camry | А123ВС163", "Сигнал Ford Focus | К621РМ163", "Сигнал Lada Vesta | М371АЕ163"][index] : first.vehicleName,
    responsibleFio: index ? undefined : "Иванов Иван",
    performer: index ? undefined : "Исполнитель из строки работ",
  }));
  const byId = new Map(cards.map((card) => [card.documentId, card]));
  const jobs = new Map();
  const listRequests = [];
  const resultRequests = [];
  let repairView;
  let browser;
  try {
    await new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolvePromise); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_BROWSER_EXECUTABLE_PATH });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (url.pathname === "/api/auth/session") return route.fulfill({ json: { enabled: true,
        user: { id: "senior", fio: "Старший механик", isAdmin: false, permissions: ["repairs"] } } });
      if (url.pathname === "/api/repairs") {
        listRequests.push(url.search);
        return route.fulfill({ json: { repairs: cards, allOpen: true, repairView } });
      }
      if (url.pathname === "/api/repairs/refresh" && request.method() === "POST") {
        const id = `22345678-abcd-1234-abcd-${String(jobs.size + 1).padStart(12, "0")}`;
        jobs.set(id, request.postDataJSON().documentIds);
        return route.fulfill({ json: { refresh: { id, status: "pending", expiresAt: new Date(Date.now() + 60_000) } } });
      }
      if (url.pathname.startsWith("/api/repairs/refresh/") && request.method() === "GET") {
        const id = url.pathname.split("/").at(-1);
        resultRequests.push(id);
        const ids = jobs.get(id);
        const removedDocumentIds = ids.includes(cards.at(-1).documentId) ? [cards.at(-1).documentId] : [];
        return route.fulfill({ json: { refresh: { id, status: "completed", removedDocumentIds,
          repairs: ids.filter((documentId) => !removedDocumentIds.includes(documentId)).map((documentId) => byId.get(documentId)) } } });
      }
      return route.fulfill({ json: { articles: [], sessions: [], vehicles: [], brandCounts: [], hasMore: false } });
    });
    await page.goto(origin);
    await page.waitForLoadState("networkidle");
    const section = page.locator("#repairs-function");
    const rows = section.locator("tbody tr");
    await section.getByRole("columnheader", { name: "Исполнитель заказа" }).waitFor();
    await section.getByRole("columnheader", { name: "Статус заказа" }).waitFor();
    assert.equal(await rows.count(), 201);
    await rows.first().getByText("Иванов Иван", { exact: true }).waitFor();
    assert.doesNotMatch(await rows.first().innerText(), /Исполнитель из строки работ/);
    await rows.first().getByText("Готов к проверке", { exact: true }).waitFor();
    assert.equal(await rows.nth(0).getAttribute("data-repair-signal"), "review");
    assert.equal(await rows.nth(1).getAttribute("data-repair-signal"), "attention");
    assert.equal(await rows.nth(2).getAttribute("data-repair-signal"), null);
    for (const [index, color] of [[0, "rgb(255, 251, 238)"], [1, "rgb(255, 244, 243)"]]) {
      assert.equal(await rows.nth(index).locator("td").first().evaluate((cell) => getComputedStyle(cell).backgroundColor), color);
    }
    if (process.env.REPAIR_STATUS_SCREENSHOT_DIR) {
      await section.getByRole("searchbox").fill("Сигнал");
      await section.screenshot({ path: join(process.env.REPAIR_STATUS_SCREENSHOT_DIR, "repair-status-desktop.png") });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await rows.first().getByText("Исполнитель заказа", { exact: true }).waitFor();
    assert.ok(await section.evaluate((element) => element.scrollWidth <= element.clientWidth));
    for (let index = 0; index < 2; index += 1) {
      const style = await rows.nth(index).evaluate((row) => ({ shadow: getComputedStyle(row).boxShadow, animation: getComputedStyle(row).animationName }));
      assert.notEqual(style.shadow, "none");
      assert.equal(style.animation, "none");
    }
    if (process.env.REPAIR_STATUS_SCREENSHOT_DIR) {
      await section.getByRole("searchbox").fill("Сигнал");
      await section.screenshot({ path: join(process.env.REPAIR_STATUS_SCREENSHOT_DIR, "repair-status-mobile.png") });
    }
    await section.getByRole("searchbox").fill("Иванов");
    assert.equal(await rows.count(), 1);
    await section.getByRole("searchbox").fill("");
    const readsBefore = listRequests.length;
    const started = performance.now();
    await section.getByRole("button", { name: "Обновить" }).click();
    await section.getByText("Показанные заказ-наряды обновлены.", { exact: true }).waitFor();
    assert.deepEqual([...jobs.values()].map((ids) => ids.length), [200, 1]);
    assert.equal(new Set([...jobs.values()].flat()).size, 201);
    assert.deepEqual(resultRequests, [...jobs.keys()]);
    assert.equal(listRequests.length, readsBefore);
    assert.equal(await rows.count(), 200);
    t.diagnostic(`201 visible orders: ${Math.round(performance.now() - started)} ms, 2 create requests and 2 result requests, simulated 1C`);

    await page.setViewportSize({ width: 1440, height: 900 });
    for (const [showStatus, showAssignee] of [[true, false], [false, true], [false, false]]) {
      repairView = { showStatus, showAssignee };
      await page.reload();
      await rows.first().locator(".repairs-vehicle-name").waitFor();
      assert.equal(await section.getByRole("columnheader", { name: "Статус заказа" }).count(), Number(showStatus));
      assert.equal(await section.getByRole("columnheader", { name: "Исполнитель заказа" }).count(), Number(showAssignee));
      assert.equal(await rows.first().locator("td").count(), 3 + Number(showStatus) + Number(showAssignee));
      assert.equal(await rows.first().getAttribute("data-repair-signal"), "review");
    }
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

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
    const clickStarted = performance.now();
    await page.locator("#repairs-refresh").click();
    const job = await claimed;
    t.diagnostic(`Local click to waiting 1C worker receiving the job: ${Math.round(performance.now() - clickStarted)} ms`);
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
