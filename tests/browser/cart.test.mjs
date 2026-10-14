import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { createAggregatorServer } from "../../src/backend/http/create-server.ts";
import { attachPurchaseReference } from "../../src/backend/purchasing/purchase-offer.ts";

// The browser uses a real local cart server; supplier searches and checks are fictional fixtures.
const offer = (supplier, quantity, reference) => attachPurchaseReference({ supplier, brand: "TEST", article: "A1", title: "Тестовый фильтр <img src=x onerror=window.cartXss=1>",
  quantity, price: supplier === "armtek" ? 100 : 120, warehouse: "Тестовый склад", deliveryDate: null, deliveryDateApproximate: false,
  link: supplier === "armtek" ? "https://etp.armtek.ru/" : "https://www.part-kom.ru/" }, reference);

async function withCartPage(check, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "aggregator-cart-browser-"));
  const previousPath = process.env.GARAGE_DB_PATH;
  const previousMode = process.env.NODE_ENV;
  process.env.GARAGE_DB_PATH = join(directory, "cart.sqlite");
  process.env.NODE_ENV = "test";
  let server;
  let browser;
  const orderCalls = [];
  try {
    const sessions = ["armtek", "part-kom"].map((supplier) => ({ supplier, authorized: true, lastCheckedAt: null, lastAuthorizedAt: null }));
    const application = {
      listSupplierSessions: () => sessions,
      getApplicabilityApiKeyState: () => ({ configured: false, persistent: false, maskedKey: null }),
      getApplicabilityProxyState: () => ({ persistent: false, activeRouteId: null, proxies: [], directLimited: false,
        usage: { requestCount: 0 }, directUsage: { requestCount: 0, secondsUntilReset: null } }),
      getApplicabilityCachedBrands: () => [],
      listApplicabilitySavedArticles: () => ({ articles: [], brandCounts: [], hasMore: false }),
      streamSearch: async (query, emit) => {
        emit({ type: "search_started", article: query.article, suppliers: ["armtek", "part-kom"] });
        emit({ type: "result", result: offer("armtek", 4, { supplier: "armtek", keyzak: "TEST01" }) });
        emit({ type: "result", result: offer("part-kom", 3, { supplier: "part-kom", makerId: "101", providerId: "202" }) });
        emit({ type: "supplier_status", supplier: "armtek", status: "completed" });
        emit({ type: "supplier_status", supplier: "part-kom", status: "completed" });
        emit({ type: "search_completed", article: query.article });
      },
      testCartOrder: async (lines, signal) => {
        orderCalls.push(structuredClone(lines));
        await options.testGate?.(signal);
        return lines.map((line) => ({ id: line.id, status: line.reference.supplier === "armtek" ? "accepted" : "unconfirmed", acceptedQuantity: line.reference.supplier === "armtek" ? line.quantity : null,
          message: line.reference.supplier === "armtek" ? "Тестовая проверка пройдена." : "PartKOM: результат не подтверждён." }));
      },
    };
    server = createAggregatorServer({ application, publicDir: resolve("src/frontend") });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_BROWSER_EXECUTABLE_PATH });
    const page = await browser.newPage({ viewport: { width: 1366, height: 850 }, reducedMotion: options.reducedMotion ?? "no-preference" });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.addInitScript(() => {
      localStorage.setItem("autoservice.supplierVisibility", JSON.stringify(["armtek", "part-kom"]));
      localStorage.setItem("autoservice.searchState", JSON.stringify({ activeTabId: "cart-test", tabs: [{ id: "cart-test", article: "A1", enabledSuppliers: ["armtek", "part-kom"], results: [] }] }));
    });
    await page.goto(origin);
    await page.waitForLoadState("networkidle");
    await page.locator("#article-input").fill("A1");
    await page.locator("#submit-button").click();
    await page.waitForFunction(() => document.querySelectorAll("#results-body .cart-offer-button").length === 2);
    await check(page, { orderCalls, origin });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server?.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    if (previousPath === undefined) delete process.env.GARAGE_DB_PATH; else process.env.GARAGE_DB_PATH = previousPath;
    if (previousMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousMode;
    await rm(directory, { recursive: true, force: true });
  }
}

test("cart adds bounded quantities after garage icon, animates, persists, edits and tests orders", async () => {
  await withCartPage(async (page, { orderCalls }) => {
    const row = page.locator("#results-body tr").first();
    const quantity = row.locator(".cart-quantity");
    await quantity.fill("99");
    assert.equal(await quantity.inputValue(), "4");
    const garageBounds = await row.locator(".garage-offer-button").boundingBox();
    const addBounds = await row.locator(".cart-offer-button").boundingBox();
    assert.ok(addBounds.x > garageBounds.x + garageBounds.width);
    const searchBounds = await page.locator("#submit-button").boundingBox();
    const cartBounds = await page.locator("#cart-toggle").boundingBox();
    assert.ok(cartBounds.x >= searchBounds.x + searchBounds.width - 1);
    await quantity.fill("2");
    await row.locator(".cart-offer-button").click();
    await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "2");
    assert.equal(await page.locator(".cart-flying-icon").count(), 1);
    await page.locator("#cart-toggle").click();
    await page.waitForFunction(() => document.querySelectorAll("#cart-items tr[data-cart-item-id]").length === 1);
    assert.ok(await page.locator("#cart-modal").isVisible());
    assert.match(await page.locator("#cart-total").textContent(), /200/);
    assert.equal(await page.evaluate(() => window.cartXss), undefined);
    assert.equal(await page.locator("#cart-items img").count(), 0);
    await page.locator("#cart-items .cart-quantity").fill("3");
    await page.locator("#cart-title").click();
    await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "3");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#cart-modal").isVisible(), false);
    assert.equal(await page.locator("#cart-toggle").evaluate((node) => node === document.activeElement), true);
    await page.locator("#results-body tr").nth(1).locator(".cart-offer-button").click();
    await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "4");
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "4");
    await page.locator("#cart-toggle").click();
    await page.waitForFunction(() => document.querySelectorAll("#cart-items tr[data-cart-item-id]").length === 2);
    await page.locator("#cart-test-order").click();
    await page.waitForFunction(() => document.querySelectorAll(".cart-item-check").length === 2);
    assert.equal(orderCalls.length, 1);
    assert.equal(orderCalls[0][0].reference.keyzak, "TEST01");
    assert.equal(orderCalls[0][0].quantity, 3);
    assert.equal(orderCalls[0][1].reference.providerId, "202");
    assert.match(await page.locator("#cart-status").textContent(), /Посмотрите результат/);
    assert.equal(await page.locator(".cart-item-check.is-accepted").count(), 1);
    assert.equal(await page.locator(".cart-item-check.is-unconfirmed").count(), 1);
    assert.match(await page.locator("#cart-total").textContent(), /420/);
    if (process.env.CART_SCREENSHOT_PATH) await page.screenshot({ path: process.env.CART_SCREENSHOT_PATH });
    await page.locator("#cart-items .cart-remove").first().click();
    await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "1");
    assert.equal(await page.locator(".cart-item-check").count(), 0);
  });
});

test("cart honors reduced motion, constrains focus and fits mobile viewport", async () => {
  await withCartPage(async (page) => {
    await page.locator("#results-body .cart-offer-button").first().click();
    await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "1");
    assert.equal(await page.locator(".cart-flying-icon").count(), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#cart-toggle").click();
    await page.waitForFunction(() => document.querySelectorAll("#cart-items tr[data-cart-item-id]").length === 1);
    const bounds = await page.locator("#cart-modal").boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
    for (let index = 0; index < 10; index++) {
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest("#cart-modal"))), true);
    }
    await page.locator("#cart-items .cart-quantity").fill("2");
    await page.keyboard.press("Tab");
    await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "2");
    assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest("#cart-modal"))), true);
    await page.locator("#cart-items .cart-remove").click();
    await page.waitForFunction(() => document.querySelector("#cart-badge").hidden);
    assert.equal(await page.locator("#cart-test-order").isDisabled(), true);
    assert.match(await page.locator(".cart-empty").textContent(), /Корзина пуста/);
  }, { reducedMotion: "reduce" });
});
