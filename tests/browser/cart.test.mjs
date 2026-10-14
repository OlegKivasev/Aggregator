import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { createAggregatorServer } from "../../src/backend/http/create-server.ts";
import { attachPurchaseReference } from "../../src/backend/purchasing/purchase-offer.ts";
import { formatDeliveryDate } from "../../src/frontend/supplier-search-summary.js";

// The browser uses a real local cart server; supplier searches and checks are fictional fixtures.
const offer = (supplier, quantity, reference, delivery = {}) => attachPurchaseReference({ supplier, brand: "TEST", article: "A1", title: "Тестовый фильтр <img src=x onerror=window.cartXss=1>",
  quantity, price: supplier === "armtek" ? 100 : 120, warehouse: "Тестовый склад", deliveryDate: null, deliveryDateApproximate: false,
  link: supplier === "armtek" ? "https://etp.armtek.ru/" : "https://www.part-kom.ru/", ...delivery }, reference);

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
        emit({ type: "result", result: offer("armtek", options.stock ?? 4, { supplier: "armtek", keyzak: "TEST01" }, options.deliveries?.armtek) });
        emit({ type: "result", result: offer("part-kom", 3, { supplier: "part-kom", makerId: "101", providerId: "202" }, options.deliveries?.partkom) });
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
    assert.equal(await page.locator("#cart-toggle").isVisible(), false);
    await quantity.fill("2");
    await row.locator(".cart-offer-button").click();
    await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "2");
    const cartBounds = await page.locator("#cart-toggle").boundingBox();
    const searchBounds = await page.locator("#submit-button").boundingBox();
    assert.ok(cartBounds.x >= searchBounds.x + searchBounds.width + 10);
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
    assert.equal(await page.locator("#cart-toggle").isVisible(), false);
    assert.equal(await page.locator("#cart-test-order").isDisabled(), true);
    assert.match(await page.locator(".cart-empty").textContent(), /Корзина пуста/);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#submit-button").evaluate((node) => node === document.activeElement), true);
  }, { reducedMotion: "reduce" });
});

test("cart toolbar hides an empty cart, uses a separate circle and keeps the larger badge visible", async () => {
  await withCartPage(async (page) => {
    const toggle = page.locator("#cart-toggle");
    assert.equal(await toggle.isVisible(), false);
    assert.equal(await page.locator("#search-form #cart-toggle").count(), 0);
    await page.locator("#results-body tr").first().locator(".cart-quantity").fill("10000");
    await page.locator("#results-body .cart-offer-button").first().click();
    await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "10000");
    for (const width of [1366, 390, 320]) {
      await page.setViewportSize({ width, height: 850 });
      const badge = page.locator("#cart-badge");
      const toolbar = page.locator(".search-toolbar");
      const badgeBounds = await badge.boundingBox();
      const toolbarBounds = await toolbar.boundingBox();
      assert.ok(badgeBounds.x >= toolbarBounds.x && badgeBounds.y >= toolbarBounds.y);
      assert.ok(badgeBounds.x + badgeBounds.width <= width && badgeBounds.y + badgeBounds.height <= toolbarBounds.y + toolbarBounds.height);
      assert.equal(await badge.evaluate((node) => getComputedStyle(node).fontSize), "11px");
      assert.equal(await toggle.evaluate((node) => getComputedStyle(node, "::before").borderRadius), "50%");
      assert.equal(await toggle.locator("img").evaluate((node) => node.complete && node.naturalWidth > 0), true);
      const unobscured = await badge.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return [[box.left + box.width / 2, box.top + 1], [box.right - 1, box.top + box.height / 2],
          [box.left + box.width / 2, box.bottom - 1], [box.left + 1, box.top + box.height / 2]]
          .map(([x, y]) => ({ x, y, hit: document.elementFromPoint(x, y)?.className,
            visible: node.closest("button").contains(document.elementFromPoint(x, y)) }));
      });
      if (process.env.CART_TOOLBAR_SCREENSHOT_DIR) await toolbar.screenshot({ path: join(process.env.CART_TOOLBAR_SCREENSHOT_DIR, `cart-toolbar-${width}.png`) });
      assert.ok(unobscured.every((point) => point.visible), JSON.stringify({ width, unobscured }));
    }
    await toggle.click();
    await page.waitForFunction(() => document.querySelectorAll("#cart-items tr[data-cart-item-id]").length === 1);
    await page.locator("#cart-items .cart-remove").click();
    await page.waitForFunction(() => document.querySelector("#cart-toggle").hidden);
    await page.keyboard.press("Escape");
    assert.equal(await toggle.isVisible(), false);
  }, { stock: 10000, reducedMotion: "reduce" });
});

test("cart supplier tabs filter rows, hide suppliers and recalculate purchase totals and final delivery dates", async () => {
  const deliveries = {
    armtek: { deliveryDate: "2028-03-10T12:00:00Z", deliveryDateTo: "2028-03-12T12:00:00Z" },
    partkom: { deliveryDate: "2028-03-11T12:00:00Z", deliveryDateTo: "2028-03-14T12:00:00Z" },
  };
  await withCartPage(async (page) => {
    await page.locator("#results-body tr").first().locator(".cart-quantity").fill("2");
    await page.locator("#results-body .cart-offer-button").first().click();
    await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "2");
    await page.locator("#results-body .cart-offer-button").nth(1).click();
    await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "3");
    await page.locator("#cart-toggle").click();
    await page.waitForFunction(() => document.querySelectorAll("#cart-tabs .cart-tab").length === 3);
    assert.equal(await page.locator("#cart-tab-all").getAttribute("aria-selected"), "true");
    assert.equal(await page.locator("#cart-items .cart-item-supplier").count(), 2);
    assert.equal(await page.locator("#cart-items .cart-item-delivery").count(), 2);
    assert.match(await page.locator("#cart-total").textContent(), /320/);
    assert.equal(await page.locator("#cart-delivery-date").textContent(), formatDeliveryDate(deliveries.partkom.deliveryDateTo));
    await page.locator("#cart-tab-armtek").click();
    assert.equal(await page.locator("#cart-items tr[data-cart-item-id]").count(), 1);
    assert.equal(await page.locator("#cart-supplier-column").isVisible(), false);
    assert.equal(await page.locator("#cart-items .cart-item-supplier").count(), 0);
    assert.match(await page.locator("#cart-total").textContent(), /200/);
    assert.equal(await page.locator("#cart-delivery-date").textContent(), formatDeliveryDate(deliveries.armtek.deliveryDateTo));
    assert.match(await page.locator("#cart-items .cart-item-delivery").textContent(), /10\.03\.2028 - 12\.03\.2028/);
    assert.equal(await page.locator("#cart-badge").textContent(), "3");
    assert.equal(await page.locator("#cart-test-order").textContent(), "Проверить всю корзину");
    await page.keyboard.press("End");
    assert.equal(await page.locator("#cart-tab-part-kom").getAttribute("aria-selected"), "true");
    assert.equal(await page.locator("#cart-tab-part-kom").evaluate((node) => node === document.activeElement), true);
    assert.match(await page.locator("#cart-total").textContent(), /120/);
    assert.equal(await page.locator("#cart-delivery-date").textContent(), formatDeliveryDate(deliveries.partkom.deliveryDateTo));
    await page.locator("#cart-items .cart-quantity").fill("2");
    await page.locator("#cart-title").click();
    await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "4");
    assert.match(await page.locator("#cart-total").textContent(), /240/);
    assert.equal(await page.locator("#cart-tab-part-kom").getAttribute("aria-selected"), "true");
    await page.locator("#cart-tab-all").click();
    assert.match(await page.locator("#cart-total").textContent(), /440/);
    assert.equal(await page.locator("#cart-supplier-column").isVisible(), true);
    if (process.env.CART_TABS_SCREENSHOT_PATH) await page.screenshot({ path: process.env.CART_TABS_SCREENSHOT_PATH });
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator("#cart-tab-armtek").getAttribute("aria-selected"), "true");
    await page.keyboard.press("Home");
    assert.equal(await page.locator("#cart-tab-all").getAttribute("aria-selected"), "true");
    await page.locator("#cart-tab-part-kom").click();
    await page.locator("#cart-items .cart-remove").click();
    await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "2");
    assert.equal(await page.locator("#cart-tab-part-kom").count(), 0);
    assert.equal(await page.locator("#cart-tab-all").getAttribute("aria-selected"), "true");
    assert.match(await page.locator("#cart-total").textContent(), /200/);
    assert.equal(await page.locator("#cart-delivery-date").textContent(), formatDeliveryDate(deliveries.armtek.deliveryDateTo));
    await page.locator("#cart-tab-armtek").click();
    await page.keyboard.press("Escape");
    await page.locator("#cart-toggle").click();
    await page.waitForFunction(() => document.querySelector("#cart-tab-all").getAttribute("aria-selected") === "true");
  }, { deliveries, reducedMotion: "reduce" });
});
