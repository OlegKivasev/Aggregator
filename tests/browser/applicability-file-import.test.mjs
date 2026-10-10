import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";

// Browser regression tests use only fictional API responses and file contents.
const vehicle = { carId: 1, makeName: "FORD", modelName: "TEST", carName: "2.0", carType: "PC", yearStart: null, yearEnd: null };
const existingEntry = { id: "existing", sku: "EXIST1", makeName: "FORD", results: [vehicle], hasSearched: true };

async function withImportPage(search, check, { configured = true } = {}) {
  const frontendDir = resolve("src/frontend");
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    const file = resolve(frontendDir, `.${path === "/" ? "/index.html" : path}`);
    if (!file.startsWith(`${frontendDir}${sep}`)) return response.writeHead(404).end();
    try {
      const content = await readFile(file);
      const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".json") ? "application/json" : file.endsWith(".png") ? "image/png" : "text/html";
      response.writeHead(200, { "Content-Type": type }).end(content);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_BROWSER_EXECUTABLE_PATH });
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((entry) => {
      localStorage.setItem("autoservice.applicabilityState", JSON.stringify({ activeTabId: "original", tabs: [
        { id: "original", name: "Импорт", sku: "", makeNames: ["FORD"], searches: [entry] },
        { id: "other", name: "Другая вкладка", sku: "", searches: [] },
      ] }));
      localStorage.setItem("autoservice.activeFunction", "applicability");
    }, existingEntry);
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/applicability/search") {
        await search(route);
      } else if (path === "/api/applicability/api-key") {
        await route.fulfill({ json: { configured, persistent: false, maskedKey: configured ? "…TEST1" : null } });
      } else if (path === "/api/suppliers/sessions") {
        await route.fulfill({ json: { sessions: [] } });
      } else if (path === "/api/garage/vehicles") {
        await route.fulfill({ json: { vehicles: [] } });
      } else if (path === "/api/applicability/cached-brands") {
        await route.fulfill({ json: { brands: [] } });
      } else {
        await route.fulfill({ json: { articles: [], brandCounts: [], hasMore: false } });
      }
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForLoadState("networkidle");
    await check(page);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const upload = async (page, contents, name = "articles.txt") => {
  await page.locator("#applicability-file-input").setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(contents) });
  await page.waitForFunction(() => document.querySelector("#applicability-file-summary").textContent || !document.querySelector("#applicability-file-feedback").hidden);
};
const waitFinished = (page) => page.waitForFunction(() => document.querySelector("#applicability-file-stop").hidden);

test("file import previews safe pairs, searches sequentially and appends incremental results", async () => {
  const calls = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let reportFirst;
  const firstStarted = new Promise((resolve) => { reportFirst = resolve; });
  const untrustedSku = "S<script>window.importXss=1</script>";
  await withImportPage(async (route) => {
    const pair = route.request().postDataJSON();
    calls.push(pair);
    if (calls.length === 1) {
      reportFirst();
      await firstGate;
    }
    if (pair.sku === "FAIL1") await route.fulfill({ status: 502, json: { message: "Applicability search failed" } });
    else await route.fulfill({ json: { results: ["NORM-1", "EMPTY1"].includes(pair.sku) ? [] : [vehicle], cacheHit: pair.brand === "HYUNDAI" } });
  }, async (page) => {
    const icon = page.locator("#applicability-file-toggle");
    const bounds = await icon.boundingBox();
    const settingsBounds = await page.locator("#applicability-settings-toggle").boundingBox();
    assert.ok(bounds.x + bounds.width <= settingsBounds.x + 1);
    assert.ok(await icon.locator("img").evaluate((image) => image.complete && image.naturalWidth > 0));
    await icon.click();
    await upload(page, `\uFEFF12345 | Hyundai\r\n12345 | Land Rover\r\n12345 | Unknown\r\n123-45 | hyundai\r\nbad\r\nFAIL1 | FORD\r\nNORM-1 | FORD\r\nEMPTY1 | FORD\r\nEXIST1 | FORD\r\n${untrustedSku} | FORD`);
    const rows = page.locator("#applicability-file-rows");
    assert.equal(await rows.locator("tr").count(), 10);
    assert.equal(await rows.locator('[data-state="skipped"]').count(), 3);
    assert.equal(await rows.locator("script").count(), 0);
    assert.equal(await page.evaluate(() => window.importXss), undefined);
    assert.equal(calls.length, 0);
    if (process.env.TEST_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.TEST_SCREENSHOT_DIR, "applicability-file-preview.png") });
    await page.locator("#applicability-file-start").click();
    await firstStarted;
    assert.equal(calls.length, 1);
    assert.equal(await rows.locator('[data-state="searching"]').count(), 1);
    assert.equal(await page.locator("#applicability-results-body tr").count(), 2);
    assert.deepEqual(await page.locator("#applicability-results-summary dd").allTextContents(), ["2", "1", "0"]);
    assert.equal(await page.locator("#applicability-submit").isDisabled(), true);
    assert.equal(await page.locator("#applicability-file-input").isDisabled(), true);
    releaseFirst();
    await waitFinished(page);
    assert.deepEqual(calls, [
      { sku: "12345", brand: "HYUNDAI" }, { sku: "12345", brand: "LAND ROVER" },
      { sku: "FAIL1", brand: "FORD" }, { sku: "NORM-1", brand: "FORD" },
      { sku: "NORM1", brand: "FORD" }, { sku: "EMPTY1", brand: "FORD" },
      { sku: untrustedSku, brand: "FORD" },
    ]);
    assert.match(await page.locator("#applicability-file-summary").textContent(), /Добавлено: 5\. Ошибок: 1\. Пропущено: 4/);
    assert.equal(await rows.locator('[data-state="error"]').textContent(), "6FAIL1FORDApplicability search failed");
    assert.match(await rows.textContent(), /Из базы/);
    assert.equal(await page.locator("#applicability-submit").isEnabled(), true);
    await page.keyboard.press("Escape");
    assert.equal(await icon.evaluate((element) => element === document.activeElement), true);
    const table = page.locator("#applicability-results-body");
    assert.equal(await table.locator("tr").count(), 6);
    assert.match(await table.textContent(), /EXIST1/);
    assert.match(await table.textContent(), /NORM1/);
    assert.match(await table.textContent(), /EMPTY1FORDНе найдено/);
    assert.doesNotMatch(await table.textContent(), /FAIL1/);
    assert.equal(await table.locator("script").count(), 0);
    const state = await page.evaluate(() => JSON.parse(localStorage.getItem("autoservice.applicabilityState")));
    assert.equal(state.tabs[0].searches.length, 6);
    assert.equal(state.tabs[1].searches.length, 0);
    assert.deepEqual(await page.locator("#applicability-results-summary dd").allTextContents(), ["6", "5", "1"]);
    if (process.env.TEST_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.TEST_SCREENSHOT_DIR, "applicability-file-results.png") });
  });
});

test("stopping import preserves completed rows, cancels queued searches and allows continuation", async () => {
  const calls = [];
  let releasePending;
  const pendingGate = new Promise((resolve) => { releasePending = resolve; });
  let reportPending;
  const pendingStarted = new Promise((resolve) => { reportPending = resolve; });
  await withImportPage(async (route) => {
    const pair = route.request().postDataJSON();
    calls.push(pair.sku);
    if (calls.length === 2) {
      reportPending();
      await pendingGate;
      await route.abort();
    } else await route.fulfill({ json: { results: [vehicle], cacheHit: false } });
  }, async (page) => {
    await page.locator("#applicability-file-toggle").click();
    await upload(page, "STOP1 | FORD\nSTOP2 | FORD\nSTOP3 | FORD");
    await page.locator("#applicability-file-start").click();
    await pendingStarted;
    await page.locator("#applicability-file-stop").click();
    await waitFinished(page);
    assert.deepEqual(calls, ["STOP1", "STOP2"]);
    assert.match(await page.locator("#applicability-file-summary").textContent(), /Очередь остановлена/);
    assert.equal(await page.locator("#applicability-results-body tr").count(), 2);
    assert.match(await page.locator("#applicability-results-body").textContent(), /STOP1/);
    assert.doesNotMatch(await page.locator("#applicability-results-body").textContent(), /STOP2/);
    assert.equal(await page.locator("#applicability-file-start").isEnabled(), true);
    releasePending();
    await page.locator("#applicability-file-start").click();
    await waitFinished(page);
    assert.deepEqual(calls, ["STOP1", "STOP2", "STOP2", "STOP3"]);
    assert.equal(await page.locator("#applicability-results-body tr").count(), 4);
    assert.equal(await page.locator('#applicability-file-rows [data-state="done"]').count(), 3);
  });
});

test("file import stops on key failure and never invents empty results", async () => {
  const calls = [];
  await withImportPage(async (route) => {
    const { sku } = route.request().postDataJSON();
    calls.push(sku);
    await route.fulfill({ status: 401, json: { message: "PartsAPI отклонил запрос для ключа …TEST1. Проверьте ключ и подписку." } });
  }, async (page) => {
    await page.locator("#applicability-file-toggle").click();
    await upload(page, "KEY1 | FORD\nKEY2 | FORD");
    await page.locator("#applicability-file-start").click();
    await waitFinished(page);
    assert.deepEqual(calls, ["KEY1"]);
    assert.match(await page.locator("#applicability-file-feedback").textContent(), /PartsAPI отклонил/);
    assert.equal(await page.locator("#applicability-results-body tr").count(), 1);
    assert.equal(await page.locator('#applicability-file-rows [data-state="pending"]').count(), 1);
  });
});

test("file import stays in its original tab and closing that tab aborts its queue", async () => {
  const calls = [];
  let releasePending;
  const pendingGate = new Promise((resolve) => { releasePending = resolve; });
  let reportPending;
  const pendingStarted = new Promise((resolve) => { reportPending = resolve; });
  await withImportPage(async (route) => {
    calls.push(route.request().postDataJSON().sku);
    reportPending();
    await pendingGate;
    await route.abort();
  }, async (page) => {
    await page.locator("#applicability-file-toggle").click();
    await upload(page, "TAB1 | FORD\nTAB2 | FORD");
    await page.locator("#applicability-file-start").click();
    await pendingStarted;
    await page.keyboard.press("Escape");
    await page.locator('[data-tab-id="other"]').click();
    assert.equal(await page.locator("#applicability-results-body tr").count(), 0);
    assert.equal(await page.locator("#applicability-submit").isDisabled(), true);
    await page.locator("#applicability-file-toggle").click();
    assert.match(await page.locator("#applicability-file-target").textContent(), /«Импорт»/);
    assert.equal(await page.locator("#applicability-file-stop").isVisible(), true);
    await page.keyboard.press("Escape");
    await page.locator('[data-close-tab-id="original"]').click();
    await waitFinished(page);
    assert.deepEqual(calls, ["TAB1"]);
    assert.equal(await page.locator("#applicability-results-body tr").count(), 0);
    assert.equal(await page.locator("#applicability-submit").isEnabled(), true);
    const state = await page.evaluate(() => JSON.parse(localStorage.getItem("autoservice.applicabilityState")));
    assert.deepEqual(state.tabs.map((tab) => tab.id), ["other"]);
    assert.equal(state.tabs[0].searches.length, 0);
    releasePending();
  });
});

test("file import reports timeout and malformed responses and continues with later rows", async () => {
  const calls = [];
  await withImportPage(async (route) => {
    const { sku } = route.request().postDataJSON();
    calls.push(sku);
    if (sku === "TIME1") await route.fulfill({ status: 504, json: { message: "Applicability search timed out" } });
    else if (sku === "BAD1") await route.fulfill({ json: { results: null, cacheHit: false } });
    else await route.fulfill({ json: { results: [vehicle], cacheHit: false } });
  }, async (page) => {
    await page.locator("#applicability-file-toggle").click();
    await upload(page, "TIME1 | FORD\nBAD1 | FORD\nGOOD1 | FORD");
    await page.locator("#applicability-file-start").click();
    await waitFinished(page);
    assert.deepEqual(calls, ["TIME1", "BAD1", "GOOD1"]);
    const rows = page.locator("#applicability-file-rows");
    assert.equal(await rows.locator('[data-state="error"]').count(), 2);
    assert.match(await rows.textContent(), /timed out/);
    assert.match(await rows.textContent(), /некорректный ответ/);
    assert.equal(await page.locator("#applicability-results-body tr").count(), 2);
    assert.match(await page.locator("#applicability-results-body").textContent(), /GOOD1/);
    assert.equal(await page.locator("#applicability-file-start").isEnabled(), true);
  });
});

test("file import validates files and missing configuration before requests and fits a narrow screen", async () => {
  let calls = 0;
  await withImportPage(async (route) => { calls += 1; await route.abort(); }, async (page) => {
    await page.setViewportSize({ width: 375, height: 760 });
    await page.locator("#applicability-file-toggle").click();
    const card = await page.locator("#applicability-file-modal .analogs-modal__card").boundingBox();
    assert.ok(card.x >= 0 && card.x + card.width <= 375);
    await upload(page, "WRONG1 | FORD", "articles.csv");
    assert.match(await page.locator("#applicability-file-feedback").textContent(), /\.txt/);
    await upload(page, " ");
    assert.match(await page.locator("#applicability-file-feedback").textContent(), /не содержит/);
    await upload(page, "AA1 | Unknown");
    assert.equal(await page.locator("#applicability-file-start").isDisabled(), true);
    await upload(page, "CONFIG1 | FORD");
    await page.locator("#applicability-file-start").click();
    await waitFinished(page);
    assert.match(await page.locator("#applicability-file-feedback").textContent(), /Укажите API-ключ/);
    assert.equal(calls, 0);
    assert.equal(await page.locator("#applicability-results-body tr").count(), 1);
    await page.locator("#applicability-file-start").focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.locator("#applicability-file-modal button.analogs-modal__close").evaluate((element) => element === document.activeElement), true);
  }, { configured: false });
});
