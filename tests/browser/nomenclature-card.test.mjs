import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { chromium, webkit } from "playwright";
import { BarcodeFormat, QRCodeWriter } from "@zxing/library";
import { createAggregatorServer } from "../../src/backend/http/create-server.ts";

// Fictional products and keys are confined to a fresh temporary test database.
const product = { id: "12345678-abcd-1234-abcd-123456789abc", name: '<img src=x onerror="window.productXss=1"> Тестовый товар',
  characteristicId: null, characteristicName: null,
  prices: { purchase: { amount: 6500, currency: "RUB" }, retail: { amount: 8800, currency: "RUB" }, retailCashless: { amount: 9750, currency: "RUB" } } };
const barcode = "2000043626425";
const body = (value, headers = {}) => ({ headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(value) });
function scanFile(value) {
  const matrix = new QRCodeWriter().encode(value, BarcodeFormat.QR_CODE, 0, 0, new Map());
  const width = matrix.getWidth();
  let path = "";
  for (let y = 0; y < width; y += 1) for (let x = 0; x < width; x += 1) if (matrix.get(x, y)) path += `M${x} ${y}h1v1h-1z`;
  return { name: "test-code.svg", mimeType: "image/svg+xml", buffer: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 ${width} ${width}"><rect width="100%" height="100%" fill="white"/><path d="${path}" fill="black"/></svg>`) };
}
async function withPage(check) {
  const directory = await mkdtemp(join(tmpdir(), "aggregator-nomenclature-card-"));
  const previous = process.env.GARAGE_DB_PATH;
  process.env.GARAGE_DB_PATH = join(directory, "database.sqlite");
  const server = createAggregatorServer({ application: { streamSearch: async () => {} }, publicDir: resolve("src/frontend") });
  let browser;
  try {
    await new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolvePromise); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const request = (path, options) => fetch(origin + path, options);
    const engine = process.env.NOMENCLATURE_BROWSER === "webkit" ? webkit : chromium;
    browser = await engine.launch({ headless: true, executablePath: process.env.TEST_BROWSER_EXECUTABLE_PATH });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.href === "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" && process.env.REPAIRS_BOOTSTRAP_CSS_PATH) {
        return route.fulfill({ contentType: "text/css", body: await readFile(process.env.REPAIRS_BOOTSTRAP_CSS_PATH) });
      }
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith("/api/") || url.pathname.startsWith("/api/nomenclature/") || url.pathname.startsWith("/api/integration/1c/nomenclature/")) return route.continue();
      const responses = {
        "/api/auth/session": { enabled: false, user: null }, "/api/repairs": { repairs: [] },
        "/api/suppliers/sessions": { sessions: [] }, "/api/applicability/api-key": { configured: false },
        "/api/applicability/proxies": { persistent: false, proxies: [], activeRouteId: null, directUsage: {}, usage: {} },
        "/api/garage/vehicles": { vehicles: [] },
      };
      return route.fulfill({ json: responses[url.pathname] ?? { articles: [], brandCounts: [], hasMore: false } });
    });
    const key = async (source) => (await (await request(`/api/nomenclature/connections/${source}`, { method: "POST", ...body({}) })).json()).token;
    const pollRequest = async (source, token, wait = 0) => {
      const response = await request(`/api/integration/1c/nomenclature/${source}/requests?waitSeconds=${wait}`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(response.status, 200);
      return (await response.json()).request;
    };
    const poll = (...args) => { const pending = pollRequest(...args); pending.catch(() => {}); return pending; };
    const complete = async (source, token, job, products) => {
      const response = await request(`/api/integration/1c/nomenclature/${source}/results`, { method: "POST", ...body({
        requestId: job.id, leaseId: job.leaseId, status: products.length ? "found" : "not_found", products,
      }, { Authorization: `Bearer ${token}` }) });
      return response.status;
    };
    const open = async () => {
      await page.goto(origin);
      await page.waitForFunction(() => window.aggregatorAuthState?.ready);
      await page.locator("#nomenclature-function-tab").click();
      await page.waitForFunction(() => !document.querySelector("#nomenclature-source-status").textContent.includes("Проверяем"));
    };
    await check({ page, request, key, poll, complete, open });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolvePromise) => server.close(resolvePromise));
    if (previous === undefined) delete process.env.GARAGE_DB_PATH; else process.env.GARAGE_DB_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test("a real scan requests the selected 1C source and renders its name and three prices safely", async () => {
  await withPage(async ({ page, request, key, poll, complete, open }) => {
    const token = await key("test");
    await poll("test", token);
    await request("/api/nomenclature/settings", { method: "PUT", ...body({ defaultSource: "test" }) });
    await open();
    await page.waitForFunction(() => document.querySelector("#nomenclature-source").value === "test");
    const waiting = poll("test", token, 20);
    await page.locator("#nomenclature-file").setInputFiles(scanFile(barcode));
    const job = await waiting;
    assert.equal(job.barcode, barcode);
    assert.equal(await complete("test", token, job, [product]), 200);
    await page.locator("#nomenclature-product").waitFor();
    assert.equal(await page.locator("#nomenclature-product-name").textContent(), product.name);
    assert.equal(await page.locator("#nomenclature-product-source").textContent(), "Тестовая база");
    assert.equal(await page.locator("#nomenclature-product img").count(), 0);
    assert.equal(await page.evaluate(() => window.productXss), undefined);
    const amounts = await page.locator("[data-nomenclature-price]").allTextContents();
    assert.deepEqual(amounts.map((value) => value.replace(/\s/g, "")), ["6500,00₽", "8800,00₽", "9750,00₽"]);
    assert.equal(await page.locator("#nomenclature-function").evaluate((element) => element.scrollWidth <= element.clientWidth), true);
    if (process.env.NOMENCLATURE_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.NOMENCLATURE_SCREENSHOT_DIR, "nomenclature-product-mobile.png"), fullPage: true });

    const next = poll("test", token, 20);
    await page.locator("#nomenclature-file").setInputFiles(scanFile("second-code"));
    const variants = [
      { ...product, characteristicId: "11111111-abcd-1234-abcd-123456789abc", characteristicName: "Синий" },
      { ...product, characteristicId: "22222222-abcd-1234-abcd-123456789abc", characteristicName: "Красный", prices: { purchase: { amount: 0, currency: "RUB" }, retail: null, retailCashless: null } },
    ];
    assert.equal(await complete("test", token, await next, variants), 200);
    await page.locator("#nomenclature-choices").waitFor();
    assert.equal(await page.locator("#nomenclature-product").isVisible(), false);
    await page.locator("#nomenclature-choices button").filter({ hasText: "Красный" }).click();
    assert.equal(await page.locator("#nomenclature-product-characteristic").textContent(), "Красный");
    assert.deepEqual((await page.locator("[data-nomenclature-price]").allTextContents()).map((value) => value.replace(/\s/g, "")), ["0,00₽", "—", "—"]);

    const missing = poll("test", token, 20);
    await page.locator("#nomenclature-file").setInputFiles(scanFile("missing-code"));
    assert.equal(await complete("test", token, await missing, []), 200);
    await page.locator("#nomenclature-lookup-feedback").getByText(/не найден/).waitFor();
    assert.equal(await page.locator("#nomenclature-product").isVisible(), false);
  });
});

test("switching the source cancels the old request and never displays its late result", async () => {
  await withPage(async ({ page, request, key, poll, complete, open }) => {
    const testToken = await key("test");
    const productionToken = await key("production");
    await poll("test", testToken); await poll("production", productionToken);
    await request("/api/nomenclature/settings", { method: "PUT", ...body({ defaultSource: "test" }) });
    await open();
    await page.waitForFunction(() => document.querySelector("#nomenclature-source").value === "test");
    const oldJob = poll("test", testToken, 20);
    await page.locator("#nomenclature-file").setInputFiles(scanFile(barcode));
    const job = await oldJob;
    const currentJob = poll("production", productionToken, 20);
    await page.locator("#nomenclature-source").selectOption("production");
    const production = await currentJob;
    assert.equal(production.barcode, barcode);
    assert.equal(await complete("test", testToken, job, [product]), 409);
    assert.equal(await page.locator("#nomenclature-product").isVisible(), false);
    assert.equal(await complete("production", productionToken, production, [{ ...product, name: "Товар основной базы" }]), 200);
    await page.locator("#nomenclature-product").waitFor();
    assert.equal(await page.locator("#nomenclature-product-name").textContent(), "Товар основной базы");
    assert.equal(await page.locator("#nomenclature-product-source").textContent(), "Основная база");
    await request("/api/nomenclature/connections/test", { method: "DELETE" });
    await page.locator("#nomenclature-source").selectOption("test");
    await page.locator("#nomenclature-lookup-feedback").getByText(/не настроено/).waitFor();
    assert.equal(await page.locator("#nomenclature-product").isVisible(), false);
  });
});

test("administrator settings issue a source key once and preserve the default source", async () => {
  await withPage(async ({ page, request, open }) => {
    await open();
    await page.locator("#settings-toggle").click();
    await page.locator("#nomenclature-settings > summary").click();
    const testSource = page.locator('[data-nomenclature-connection="test"]');
    await testSource.locator("[data-connection-key]").click();
    await page.locator("#nomenclature-new-key").waitFor();
    assert.match(await page.locator("#nomenclature-key-value").inputValue(), /^[A-Za-z0-9_-]{43}$/);
    await page.locator("#nomenclature-default-source").selectOption("test");
    const saved = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/nomenclature/settings" && response.request().method() === "PUT");
    await page.locator("#nomenclature-settings-save").click();
    assert.equal((await saved).status(), 200);
    assert.equal((await (await request("/api/nomenclature/sources")).json()).defaultSource, "test");
    await page.locator("#nomenclature-settings > summary").click();
    await page.waitForFunction(() => document.querySelector("#nomenclature-key-value").value === "");
    await page.locator("#nomenclature-settings > summary").click();
    assert.equal(await page.locator("#nomenclature-new-key").isVisible(), false);
    const productionSource = page.locator('[data-nomenclature-connection="production"]');
    await productionSource.locator("[data-connection-key]").click();
    await page.locator("#nomenclature-new-key").waitFor();
    if (process.env.NOMENCLATURE_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.NOMENCLATURE_SCREENSHOT_DIR, "nomenclature-settings-mobile.png"), fullPage: true, mask: [page.locator("#nomenclature-key-value")] });
    await page.locator("#settings-close").click();
    await page.waitForFunction(() => document.querySelector("#nomenclature-key-value").value === "");
  });
});
