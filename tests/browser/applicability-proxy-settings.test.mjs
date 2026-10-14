import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { createAggregatorServer } from "../../src/backend/http/create-server.ts";
import { EncryptedPartsApiProxyStore } from "../../src/backend/applicability/encrypted-proxy-store.ts";
import { PartsApiApplicabilityClient } from "../../src/backend/applicability/partsapi-client.ts";
import { PartsApiRoutingClient } from "../../src/backend/applicability/partsapi-routing-client.ts";

// Browser + real application transport/storage; all PartsAPI/proxy traffic is a fictional fixture.
test("PartsAPI proxy settings save secrets securely, switch automatically and allow manual retry", { timeout: 60000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "browser-partsapi-proxy-"));
  const path = join(directory, "proxies.enc.json");
  const proxies = new EncryptedPartsApiProxyStore(path, Buffer.alloc(32, 8));
  let mode = "direct-limit";
  const calls = [];
  const response = (host) => {
    calls.push(host);
    return (host === null && mode === "direct-limit") || mode === "all-limited"
      ? Response.json({ error_code: 5000, message: "Exceeded the number of requests from the current IP address.", status: 401 }, { status: 401 })
      : mode === "empty" ? Response.json([])
      : Response.json([{ carId: 1, carName: "Test", carType: "PC", makeName: "FORD", modelName: "Test", yearEnd: null, yearStart: null }]);
  };
  const routing = new PartsApiRoutingClient(new PartsApiApplicabilityClient(async () => response(null), async (_url, proxy) => response(proxy.host)), proxies);
  const application = {
    listSupplierSessions: () => [],
    streamSearch: async () => {},
    getApplicabilityApiKeyState: () => ({ configured: true, persistent: true, maskedKey: "…ABCDE" }),
    getApplicabilityCachedBrands: () => [],
    listApplicabilitySavedArticles: () => ({ articles: [], brandCounts: [], hasMore: false }),
    getApplicabilityProxyState: () => proxies.getState(),
    addApplicabilityProxy: (config) => proxies.add(config),
    importApplicabilityProxies: (configs) => proxies.import(configs),
    selectApplicabilityProxy: (id) => proxies.select(id),
    deleteApplicabilityProxy: (id) => proxies.delete(id),
    resetApplicabilityProxyUsage: (id) => proxies.resetUsage(id),
    searchApplicability: async (query, signal) => ({ results: await routing.search({ ...query, apiKey: "fictional-key-ABCDE" }, signal), cacheHit: false }),
  };
  const server = createAggregatorServer({ application, publicDir: resolve("src/frontend"), reportError: () => {} });
  let browser;
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_BROWSER_EXECUTABLE_PATH });
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    await page.goto(baseUrl);
    await page.waitForLoadState("networkidle");
    await page.locator("#applicability-function-tab").click();
    const indicator = page.locator("#applicability-route-indicator");
    await page.waitForFunction(() => document.querySelector("#applicability-route-indicator").textContent.includes("прямое соединение"));
    await indicator.click();
    assert.equal(await page.locator("#applicability-proxy-form").isVisible(), false);
    assert.equal(await page.locator("#applicability-proxy-usage").count(), 0);
    assert.equal(await page.locator("#applicability-proxy-persistence").count(), 0);
    assert.equal(await page.locator("#applicability-concurrency-hint").count(), 0);
    assert.doesNotMatch(await page.locator("#applicability-proxy-settings").textContent(), /Файл UTF-8|При лимите по IP запрос повторится|Основной ключ:/);
    await page.getByText("Добавить прокси вручную", { exact: true }).click();
    for (const host of ["8.8.8.8", "edge-9-9-9-9.proxy.example.org"]) {
      await page.locator("#applicability-proxy-host").fill(host);
      assert.equal(await page.locator("#applicability-proxy-host").inputValue(), host);
      await page.locator("#applicability-proxy-protocol").selectOption(host === "8.8.8.8" ? "http" : "https");
      await page.locator("#applicability-proxy-port").fill("8000");
      await page.locator("#applicability-proxy-login").fill("fictional-private-proxy-user");
      await page.locator("#applicability-proxy-password").fill(" fictional-proxy-password% ");
      await page.locator("#applicability-proxy-add").click();
      await page.waitForFunction((expected) => [...document.querySelectorAll(".applicability-proxy-route")].some((row) => row.textContent.includes(expected)), host);
      assert.equal(await page.locator("#applicability-proxy-password").inputValue(), "");
    }
    assert.ok(!readFileSync(path, "utf8").includes("fictional-proxy-password"));
    const rows = page.locator(".applicability-proxy-route");
    const first = rows.filter({ hasText: "8.8.8.8" });
    await first.getByRole("button", { name: "Выбрать", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#applicability-route-indicator").textContent.includes("8.8.8.8"));
    const direct = rows.filter({ hasText: "Прямое соединение" });
    await direct.getByRole("button", { name: "Выбрать", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#applicability-route-indicator").textContent.includes("прямое соединение"));
    await page.locator("#applicability-settings-close").click();
    await page.locator("#applicability-make").fill("FORD");
    await page.getByRole("option", { name: "FORD", exact: true }).click();
    await page.locator("#applicability-sku").fill("TEST1");
    await page.locator("#applicability-submit").click();
    await page.waitForFunction(() => document.querySelector("#applicability-route-indicator").textContent.includes("автопереключение"));
    assert.deepEqual(calls, [null, "8.8.8.8"]);
    assert.equal(proxies.getState().directLimited, true);
    assert.match(await page.locator("#applicability-route-notice").textContent(), /автоматически переключён.*8\.8\.8\.8/);
    assert.equal(await page.locator("#applicability-route-notice").isVisible(), true);
    await indicator.click();
    await page.waitForFunction(() => document.querySelector("#applicability-route-indicator").textContent.includes("1 запрос"));
    assert.match(await indicator.textContent(), /1 запрос/);
    assert.match(await indicator.getAttribute("title"), /Выбранное соединение: 1 запрос\. Данные: 1; пустые ответы: 0; ошибки и отмены: 0/);
    assert.equal(await direct.locator(".applicability-proxy-timer").textContent(), "00:00:00");
    assert.match(await first.locator(".applicability-proxy-timer").textContent(), /^(24:00:00|23:59:\d{2})$/);
    const firstTime = await first.locator(".applicability-proxy-timer").textContent();
    await page.waitForFunction(({ host, time }) => [...document.querySelectorAll(".applicability-proxy-route")].find((row) => row.textContent.includes(host)).querySelector(".applicability-proxy-timer").textContent !== time, { host: "8.8.8.8", time: firstTime });
    assert.match(await rows.filter({ hasText: "8.8.8.8" }).locator("small").textContent(), /1 запрос/);
    await page.locator("#applicability-settings-close").click();
    mode = "all-limited";
    await page.locator("#applicability-sku").fill("TEST2");
    await page.locator("#applicability-submit").click();
    await page.waitForFunction(() => document.querySelector("#applicability-route-indicator").textContent.includes("лимит IP"));
    assert.deepEqual(calls, [null, "8.8.8.8", "8.8.8.8", "edge-9-9-9-9.proxy.example.org"]);
    await indicator.click();
    const second = rows.filter({ hasText: "edge-9-9-9-9.proxy.example.org" });
    await second.getByRole("button", { name: "Повторить", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#applicability-route-indicator").dataset.limited === "false");
    assert.equal(await second.getAttribute("data-active"), "true");
    assert.equal(await first.getAttribute("data-limited"), "true");
    mode = "empty";
    await page.locator("#applicability-settings-close").click();
    await page.locator("#applicability-sku").fill("TEST3");
    await page.locator("#applicability-submit").click();
    await page.waitForFunction(() => document.querySelector("#applicability-route-indicator").title.includes("пустые ответы: 1"));
    assert.match(await indicator.textContent(), /2 запроса/);
    assert.match(await indicator.getAttribute("title"), /Данные: 0; пустые ответы: 1; ошибки и отмены: 1/);
    await indicator.click();
    assert.match(await second.locator(".applicability-proxy-counter").getAttribute("title"), /Данные: 0; пустые ответы: 1; ошибки и отмены: 1/);
    await second.getByRole("button", { name: /^Сбросить счётчики и таймер:/ }).click();
    await page.waitForFunction(() => document.querySelector("#applicability-toast").textContent === "Счётчики и таймер сброшены.");
    assert.equal(await page.locator("#applicability-toast").isVisible(), true);
    assert.equal(await page.locator("#applicability-toast").getAttribute("data-tone"), "success");
    assert.ok((await page.locator("#applicability-toast").boundingBox()).y < 40);
    assert.equal(await page.locator("#applicability-proxy-feedback").isVisible(), false);
    assert.equal(await second.locator(".applicability-proxy-counter").textContent(), "0 запросов");
    assert.match(await indicator.textContent(), /0 запросов/);
    assert.match(await indicator.getAttribute("title"), /Данные: 0; пустые ответы: 0; ошибки и отмены: 0/);
    assert.equal(await second.locator(".applicability-proxy-timer").textContent(), "00:00:00");
    assert.equal(await second.getAttribute("data-active"), "true");
    assert.match(await first.locator(".applicability-proxy-counter").textContent(), /2 запроса/);
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }));
    assert.ok(!stored.includes("fictional-proxy-password"));
    assert.ok(!stored.includes("fictional-private-proxy-user"));
    if (process.env.TEST_PROXY_SCREENSHOT) await page.screenshot({ path: process.env.TEST_PROXY_SCREENSHOT, fullPage: true });
    await page.setViewportSize({ width: 375, height: 760 });
    const resetBounds = await second.getByRole("button", { name: /^Сбросить счётчики и таймер:/ }).boundingBox();
    assert.ok(resetBounds.x >= 0 && resetBounds.x + resetBounds.width <= 375);
    if (process.env.TEST_PROXY_MOBILE_SCREENSHOT) await page.screenshot({ path: process.env.TEST_PROXY_MOBILE_SCREENSHOT, fullPage: true });
    await page.setViewportSize({ width: 1366, height: 900 });
    await first.getByRole("button", { name: "Удалить", exact: true }).click();
    await page.waitForFunction(() => ![...document.querySelectorAll(".applicability-proxy-route")].some((row) => row.textContent.includes("8.8.8.8")));
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(() => document.querySelector("#applicability-route-indicator").textContent.includes("edge-9-9-9-9.proxy.example.org"));
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("repeated file imports grow beyond 100 proxies and preserve automatic switching and daily reset", { timeout: 60000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "browser-partsapi-import-"));
  const path = join(directory, "proxies.enc.json");
  let now = Date.now();
  const proxies = new EncryptedPartsApiProxyStore(path, Buffer.alloc(32, 8), () => now);
  const calls = [];
  const response = (url, host) => {
    const sku = url.searchParams.get("sku");
    calls.push({ host, sku });
    return host === null || host === "edge-0.proxy.example.org"
      ? Response.json({ error_code: 5000, message: "Exceeded the number of requests from the current IP address.", status: 401 }, { status: 401 })
      : sku === "ORIGINAL2" ? Response.json([])
      : Response.json([{ carId: 1, carName: "Test", carType: "PC", makeName: "FORD", modelName: "Test", yearEnd: null, yearStart: null }]);
  };
  const routing = new PartsApiRoutingClient(new PartsApiApplicabilityClient(async (url) => response(url, null), async (url, proxy) => response(url, proxy.host)), proxies);
  const application = {
    listSupplierSessions: () => [], streamSearch: async () => {},
    getApplicabilityApiKeyState: () => ({ configured: true, persistent: true, maskedKey: "…ABCDE" }),
    getApplicabilityCachedBrands: () => [],
    listApplicabilitySavedArticles: () => ({ articles: [], brandCounts: [], hasMore: false }),
    getApplicabilityProxyState: () => proxies.getState(),
    addApplicabilityProxy: (config) => proxies.add(config),
    importApplicabilityProxies: (configs) => proxies.import(configs),
    selectApplicabilityProxy: (id) => proxies.select(id), deleteApplicabilityProxy: (id) => proxies.delete(id),
    resetApplicabilityProxyUsage: (id) => proxies.resetUsage(id),
    searchApplicability: async (query, signal) => ({ results: await routing.search({ ...query, apiKey: "fictional-key-ABCDE" }, signal), cacheHit: false }),
  };
  const server = createAggregatorServer({ application, publicDir: resolve("src/frontend"), reportError: () => {} });
  let browser;
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_BROWSER_EXECUTABLE_PATH });
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForLoadState("networkidle");
    await page.locator("#applicability-function-tab").click();
    await page.locator("#applicability-route-indicator").click();
    const file = (text) => ({ name: "fictional-proxies.txt", mimeType: "text/plain", buffer: Buffer.from(text) });
    await page.locator("#applicability-proxy-import-file").setInputFiles(file("8.8.8.8:8080:user:secret\n127.0.0.1:8080:user:secret"));
    await page.locator("#applicability-proxy-import").click();
    await page.waitForFunction(() => document.querySelector("#applicability-proxy-feedback").textContent.includes("Строка 2"));
    assert.equal(proxies.getState().proxies.length, 0);
    const text = Array.from({ length: 100 }, (_, index) => `edge-${index}.proxy.example.org:8080:fictional-import-user:fictional-import-password`).join("\r\n");
    await page.locator("#applicability-proxy-import-file").setInputFiles(file(text));
    await page.locator("#applicability-proxy-import").click();
    await page.waitForFunction(() => document.querySelector("#applicability-proxy-feedback").textContent.includes("Импортировано: 100"));
    assert.equal(await page.locator(".applicability-proxy-route").count(), 101);
    assert.equal(await page.locator("#applicability-proxy-add").isEnabled(), true);
    assert.equal(await page.locator("#applicability-proxy-import").isEnabled(), true);
    const largerFile = Array.from({ length: 125 }, (_, index) => `edge-${index}.proxy.example.org:8080:fictional-import-user:fictional-import-password`).join("\n");
    await page.locator("#applicability-proxy-import-file").setInputFiles(file(largerFile));
    await page.locator("#applicability-proxy-import").click();
    await page.waitForFunction(() => document.querySelector("#applicability-proxy-feedback").textContent.includes("Импортировано: 25. Дубликатов пропущено: 100"));
    assert.equal(await page.locator(".applicability-proxy-route").count(), 126);
    await page.locator("#applicability-proxy-import-file").setInputFiles(file(largerFile));
    await page.locator("#applicability-proxy-import").click();
    await page.waitForFunction(() => document.querySelector("#applicability-proxy-feedback").textContent.includes("Импортировано: 0. Дубликатов пропущено: 125"));
    await page.getByText("Добавить прокси вручную", { exact: true }).click();
    await page.locator("#applicability-proxy-host").fill("8.8.8.8");
    await page.locator("#applicability-proxy-port").fill("8080");
    await page.locator("#applicability-proxy-add").click();
    await page.waitForFunction(() => document.querySelectorAll(".applicability-proxy-route").length === 127);
    assert.equal(proxies.getState().proxies.length, 126);
    assert.ok(!readFileSync(path, "utf8").includes("fictional-import-password"));
    await page.locator("#applicability-settings-close").click();
    await page.locator("#applicability-make").fill("FORD");
    await page.getByRole("option", { name: "FORD", exact: true }).click();
    await page.locator("#applicability-sku").fill("AA - 1");
    await page.locator("#applicability-submit").click();
    await page.waitForFunction(() => document.querySelector("#applicability-route-notice").textContent.includes("edge-1.proxy.example.org"));
    await page.waitForFunction(() => !document.querySelector("#applicability-submit").disabled);
    assert.deepEqual(calls, [{ host: null, sku: "AA1" }, { host: "edge-0.proxy.example.org", sku: "AA1" }, { host: "edge-1.proxy.example.org", sku: "AA1" }]);
    assert.equal(await page.locator("#applicability-route-notice").isVisible(), true);
    await page.locator("#applicability-sku").fill("ORIGINAL-2");
    await page.locator("#applicability-submit").click();
    await page.waitForFunction(() => !document.querySelector("#applicability-submit").disabled);
    assert.equal(calls.length, 4);
    assert.deepEqual(calls.at(-1), { host: "edge-1.proxy.example.org", sku: "ORIGINAL2" });
    now += 86_400_000;
    await page.locator("#applicability-route-indicator").click();
    await page.waitForFunction(() => [...document.querySelectorAll(".applicability-proxy-route")].find((row) => row.textContent.includes("edge-1.proxy.example.org")).querySelector(".applicability-proxy-counter").textContent === "0 запросов");
    assert.equal(await page.locator(".applicability-proxy-route").filter({ hasText: "edge-1.proxy.example.org" }).locator(".applicability-proxy-timer").textContent(), "00:00:00");
    assert.equal(proxies.getState().directLimited, true);
    assert.equal(proxies.getState().proxies[0].limited, true);
    assert.equal(proxies.getState().proxies[1].usage.requestCount, 0);
    assert.equal(new EncryptedPartsApiProxyStore(path, Buffer.alloc(32, 8), () => now).getState().proxies[1].usage.resetAt, null);
    const localState = await page.evaluate(() => JSON.stringify({ ...localStorage }));
    assert.ok(!localState.includes("fictional-import-password"));
    assert.ok(!localState.includes("fictional-import-user"));
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#applicability-route-indicator").textContent.includes("edge-1.proxy.example.org"));
    assert.equal(await page.locator(".applicability-proxy-route").count(), 127);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
