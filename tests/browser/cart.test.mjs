import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { createAggregatorServer } from "../../src/backend/http/create-server.ts";
import { attachPurchaseReference } from "../../src/backend/purchasing/purchase-offer.ts";
import { formatDeliveryDate } from "../../src/frontend/supplier-search-summary.js";
import { testPurchaseOrder } from "../../src/backend/application/test-order-application-service.ts";

// The browser uses a real local cart server; supplier searches and checks are fictional fixtures.
const supplierOrigins = { armtek: "https://etp.armtek.ru/", "part-kom": "https://www.part-kom.ru/",
  "forum-auto": "https://itrade.forum-auto.ru/", rossko: "https://samara.rossko.ru/" };
const offer = (supplier, quantity, reference, delivery = {}, title = "Тестовый фильтр <img src=x onerror=window.cartXss=1>") => attachPurchaseReference({ supplier, brand: "TEST", article: "A1", title,
  quantity, price: supplier === "armtek" ? 100 : 120, warehouse: "Тестовый склад", deliveryDate: null, deliveryDateApproximate: false,
  link: supplierOrigins[supplier], ...delivery }, reference);

async function withCartPage(check, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "aggregator-cart-browser-"));
  const previousPath = process.env.GARAGE_DB_PATH;
  const previousMode = process.env.NODE_ENV;
  process.env.GARAGE_DB_PATH = join(directory, "cart.sqlite");
  process.env.NODE_ENV = "test";
  let server;
  let browser;
  const orderCalls = [];
  const refreshCalls = [];
  try {
    const suppliers = options.allSuppliers ? ["armtek", "part-kom", "forum-auto", "rossko"] : ["armtek", "part-kom"];
    const sessions = suppliers.map((supplier) => ({ supplier, authorized: true, lastCheckedAt: null, lastAuthorizedAt: null }));
    const application = {
      listSupplierSessions: () => sessions,
      getApplicabilityApiKeyState: () => ({ configured: false, persistent: false, maskedKey: null }),
      getApplicabilityProxyState: () => ({ persistent: false, activeRouteId: null, proxies: [], directLimited: false,
        usage: { requestCount: 0 }, directUsage: { requestCount: 0, secondsUntilReset: null } }),
      getApplicabilityCachedBrands: () => [],
      listApplicabilitySavedArticles: () => ({ articles: [], brandCounts: [], hasMore: false }),
      streamSearch: async (query, emit) => {
        emit({ type: "search_started", article: query.article, suppliers });
        emit({ type: "result", result: offer("armtek", options.stock ?? 4, { supplier: "armtek", keyzak: "TEST01" }, options.deliveries?.armtek, options.title) });
        emit({ type: "result", result: offer("part-kom", 3, { supplier: "part-kom", makerId: "101", providerId: "202" }, options.deliveries?.partkom, options.title) });
        if (options.allSuppliers) {
          emit({ type: "result", result: offer("forum-auto", 3, { supplier: "forum-auto", warehouse: "Тестовый склад", gid: "fixture-gid" }, options.deliveries?.forum, options.title) });
          emit({ type: "result", result: offer("rossko", 3, { supplier: "rossko", partGuid: "fixture-guid", stockId: "fixture-stock" }, options.deliveries?.rossko, options.title) });
          emit({ type: "supplier_status", supplier: "forum-auto", status: "completed" });
          emit({ type: "supplier_status", supplier: "rossko", status: "completed" });
        }
        emit({ type: "supplier_status", supplier: "armtek", status: "completed" });
        emit({ type: "supplier_status", supplier: "part-kom", status: "completed" });
        emit({ type: "search_completed", article: query.article });
      },
      testCartOrder: async (lines, signal) => {
        orderCalls.push(structuredClone(lines));
        await options.testGate?.(signal);
        return testPurchaseOrder(lines, signal);
      },
      realCartOrder: {
        refresh: async (lines) => { refreshCalls.push(structuredClone(lines)); await options.refreshGate?.(); return lines.map((line) => ({ ...structuredClone(line),
          result: { ...line.result, price: options.refreshedPrice ?? line.result.price } })); },
        choices: async () => ({ partKom: { deliveries: [{ id: "regular", label: "Обычная доставка", type: "regular" }] },
          rossko: { deliveries: [{ id: "delivery", label: "Доставка", addressId: null }],
            payments: [{ id: "bank", label: "Оплата банковским платежом" }], companies: [] } }),
        prepare: async (_supplier, lines) => async (_attemptId, signal) => {
          orderCalls.push(structuredClone(lines));
          await options.testGate?.(signal);
          return { confirmed: lines.map((line) => ({ id: line.id, acceptedQuantity: line.quantity, orderIds: [`fixture-${line.reference.supplier}`],
            ...(line.reference.supplier === "part-kom" && options.partKomReceipt ? { partKomOrders: [{ orderNumber: "fixture-part-kom",
              quantity: line.quantity, ...options.partKomReceipt }] } : {}),
            ...(line.reference.supplier === "forum-auto" && options.forumAutoReceipt ? { forumAutoOrder: {
              orderId: "fixture-forum-auto", orderedQuantity: line.quantity, ...options.forumAutoReceipt } } : {}) })), rejected: [] };
        },
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
    await page.addInitScript((suppliers) => {
      localStorage.setItem("autoservice.supplierVisibility", JSON.stringify(suppliers));
      localStorage.setItem("autoservice.searchState", JSON.stringify({ activeTabId: "cart-test", tabs: [{ id: "cart-test", article: "A1", enabledSuppliers: suppliers, results: [] }] }));
    }, suppliers);
    await page.goto(origin);
    await page.waitForLoadState("networkidle");
    await page.locator("#article-input").fill("A1");
    await page.locator("#submit-button").click();
    await page.waitForFunction((count) => document.querySelectorAll("#results-body .cart-offer-button").length === count, suppliers.length);
    await check(page, { orderCalls, refreshCalls, origin });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server?.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    if (previousPath === undefined) delete process.env.GARAGE_DB_PATH; else process.env.GARAGE_DB_PATH = previousPath;
    if (previousMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousMode;
    await rm(directory, { recursive: true, force: true });
  }
}

async function openCheckout(page) {
  if (!await page.locator("#cart-items .cart-item-select:checked").count()) await page.locator("#cart-select-all").check();
  await page.locator("#cart-test-order").click();
  await page.waitForFunction(() => document.querySelector("#cart-order-confirm").open);
}

test("cart adds bounded quantities, persists, orders and removes confirmed items", async () => {
  await withCartPage(async (page, { orderCalls }) => {
    const row = page.locator("#results-body tr").first();
    const quantity = row.locator(".cart-quantity");
    await quantity.fill("99");
    assert.equal(await quantity.inputValue(), "4");
    const garageBounds = await row.locator(".garage-offer-button").boundingBox();
    const addBounds = await row.locator(".cart-offer-button").boundingBox();
    assert.equal(await row.locator(".garage-add-cell").count(), 0);
    assert.equal(await row.locator(".cart-add-cell .garage-offer-button").count(), 1);
    assert.ok(Math.abs(addBounds.x - garageBounds.x) <= 1);
    assert.ok(garageBounds.y >= addBounds.y + addBounds.height + 2);
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
    await page.locator("#cart-select-all").check();
    assert.ok(await page.locator("#cart-modal").isVisible());
    assert.match(await page.locator("#cart-total .cart-purchase-price").textContent(), /200/);
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
    await openCheckout(page);
    assert.equal(await page.locator("#cart-partkom-delivery").count(), 0);
    assert.equal(await page.locator("#cart-order-fields").count(), 0);
    await page.locator("#cart-order-accept").click();
    await page.waitForFunction(() => document.querySelector("#cart-order-status").classList.contains("is-success"));
    assert.equal(orderCalls.length, 2);
    assert.equal(orderCalls[0][0].reference.keyzak, "TEST01");
    assert.equal(orderCalls[0][0].quantity, 3);
    assert.equal(orderCalls[1][0].reference.providerId, "202");
    assert.match(await page.locator("#cart-status").textContent(), /Заказ успешно оформлен/);
    assert.equal(await page.locator("#cart-order-receipt p").count(), 2);
    await page.locator("#cart-order-cancel").click();
    assert.equal(await page.locator("#cart-badge").isVisible(), false);
    if (process.env.CART_SCREENSHOT_PATH) await page.screenshot({ path: process.env.CART_SCREENSHOT_PATH });
    assert.match(await page.locator(".cart-empty").textContent(), /Корзина пуста/);
  });
});

test("checkout orders only marked goods and keeps unmarked goods in the cart", async () => {
  await withCartPage(async (page, { orderCalls }) => {
    await page.locator("#results-body .cart-offer-button").first().click();
    await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "1");
    await page.locator("#results-body .cart-offer-button").nth(1).click();
    await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "2");
    await page.locator("#cart-toggle").click();
    await page.waitForFunction(() => document.querySelectorAll("#cart-items tr[data-cart-item-id]").length === 2);
    assert.equal(await page.locator("#cart-test-order").isDisabled(), true);
    assert.equal(await page.locator("#cart-total .cart-purchase-price").textContent(), "0,00 ₽");
    await page.locator("#cart-items .cart-item-select").nth(1).check();
    assert.equal(await page.locator("#cart-summary").textContent(), "Количество: 2 шт. Выбрано к заказу: 1 шт.");
    assert.equal(await page.locator("#cart-total .cart-purchase-price").textContent(), "120,00 ₽");
    await page.locator("#cart-tab-armtek").click();
    assert.equal(await page.locator("#cart-test-order").isDisabled(), true);
    await page.locator("#cart-tab-all").click();
    assert.equal(await page.locator("#cart-items .cart-item-select:checked").count(), 1);
    await openCheckout(page);
    assert.deepEqual(await page.locator(".cart-order-group h3").allTextContents(), ["PartKOM"]);
    await page.locator("#cart-order-accept").click();
    await page.waitForFunction(() => document.querySelector("#cart-order-status").classList.contains("is-success"));
    assert.deepEqual(orderCalls.map(([line]) => line.reference.supplier), ["part-kom"]);
    await page.locator("#cart-order-cancel").click();
    assert.equal(await page.locator("#cart-badge").textContent(), "1");
    assert.equal(await page.locator("#cart-items .cart-item-supplier").textContent(), "ArmtekТестовый склад");
    assert.equal(await page.locator("#cart-test-order").isDisabled(), true);
  }, { reducedMotion: "reduce" });
});

test("successful PartKOM checkout displays the confirmed order motion without a history page", async () => {
  await withCartPage(async (page) => {
    await page.locator("#results-body .cart-offer-button").nth(1).click();
    await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "1");
    await page.locator("#cart-toggle").click();
    await page.waitForFunction(() => document.querySelectorAll("#cart-items tr[data-cart-item-id]").length === 1);
    await openCheckout(page);
    await page.locator("#cart-order-accept").click();
    await page.waitForFunction(() => document.querySelector("#cart-order-status").classList.contains("is-success"));
    const receipt = page.locator(".cart-partkom-receipt");
    assert.equal(await receipt.count(), 1);
    assert.match(await receipt.textContent(), /fixture-part-kom/);
    assert.match(await receipt.textContent(), /Принят в работу/);
    assert.match(await receipt.textContent(), /2026-10-20/);
    assert.match(await receipt.textContent(), /120,00/);
    assert.equal(await receipt.locator("img").count(), 0);
    assert.equal(await page.evaluate(() => window.cartXss), undefined);
    assert.equal(await page.locator("#cart-badge").isVisible(), false);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await receipt.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
  }, { reducedMotion: "reduce", partKomReceipt: { orderDate: "2026-10-15 12:33:00", detailNum: "A1", maker: "TEST",
    description: "Деталь <img src=x onerror=window.cartXss=1>", price: 120, expectedDate: "2026-10-17",
    guaranteedDate: "2026-10-20", stateTxt: "Принят в работу", refusalCount: 0, storeCount: 0,
    releaseCount: 0, comment: "Проверено" } });
});

test("successful Forum Auto checkout displays the supplier order details", async () => {
  await withCartPage(async (page) => {
    await page.locator("#results-body .cart-offer-button").nth(2).click();
    await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "1");
    await page.locator("#cart-toggle").click();
    await openCheckout(page);
    await page.locator("#cart-order-accept").click();
    await page.waitForFunction(() => document.querySelector("#cart-order-status").classList.contains("is-success"));
    const receipt = page.locator(".cart-forum-receipt");
    assert.equal(await receipt.count(), 1);
    assert.match(await receipt.textContent(), /fixture-forum-auto/);
    assert.match(await receipt.textContent(), /Отправлен на бронирование/);
    assert.match(await receipt.textContent(), /17\.10\.2026/);
    assert.match(await receipt.textContent(), /Забронировано1/);
    assert.equal(await receipt.locator("img").count(), 0);
    assert.equal(await page.evaluate(() => window.cartXss), undefined);
    assert.equal(await page.locator("#cart-badge").isVisible(), false);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await receipt.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
  }, { allSuppliers: true, reducedMotion: "reduce", forumAutoReceipt: {
    status: "Отправлен на бронирование", createdAt: "15.10.2026 12:30:00", deliveryAt: "17.10.2026 09:00:00",
    article: "A1", brand: "TEST", title: "Деталь <img src=x onerror=window.cartXss=1>", reservedQuantity: 1,
    confirmedQuantity: 0, price: 120, total: 120 } });
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
    await page.waitForFunction(() => document.activeElement?.id === "submit-button");
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
    await page.locator("#cart-select-all").check();
    assert.equal(await page.locator("#cart-tab-all").getAttribute("aria-selected"), "true");
    assert.equal(await page.locator("#cart-items .cart-item-supplier").count(), 2);
    assert.equal(await page.locator("#cart-items .cart-item-delivery").count(), 2);
    assert.match(await page.locator("#cart-total .cart-purchase-price").textContent(), /320/);
    assert.equal(await page.locator("#cart-delivery-date").textContent(), formatDeliveryDate(deliveries.partkom.deliveryDateTo));
    await page.locator("#cart-tab-armtek").click();
    assert.equal(await page.locator("#cart-items tr[data-cart-item-id]").count(), 1);
    assert.equal(await page.locator("#cart-supplier-column").isVisible(), false);
    assert.equal(await page.locator("#cart-items .cart-item-supplier").count(), 0);
    assert.match(await page.locator("#cart-total .cart-purchase-price").textContent(), /200/);
    assert.equal(await page.locator("#cart-delivery-date").textContent(), formatDeliveryDate(deliveries.armtek.deliveryDateTo));
    assert.match(await page.locator("#cart-items .cart-item-delivery").textContent(), /10\.03\.2028 - 12\.03\.2028/);
    assert.equal(await page.locator("#cart-badge").textContent(), "3");
    assert.equal(await page.locator("#cart-test-order").textContent(), "Оформить заказ");
    await page.keyboard.press("End");
    assert.equal(await page.locator("#cart-tab-part-kom").getAttribute("aria-selected"), "true");
    assert.equal(await page.locator("#cart-tab-part-kom").evaluate((node) => node === document.activeElement), true);
    assert.match(await page.locator("#cart-total .cart-purchase-price").textContent(), /120/);
    assert.equal(await page.locator("#cart-delivery-date").textContent(), formatDeliveryDate(deliveries.partkom.deliveryDateTo));
    await page.locator("#cart-items .cart-quantity").fill("2");
    await page.locator("#cart-title").click();
    await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "4");
    assert.match(await page.locator("#cart-total .cart-purchase-price").textContent(), /240/);
    assert.equal(await page.locator("#cart-tab-part-kom").getAttribute("aria-selected"), "true");
    await page.locator("#cart-tab-all").click();
    assert.match(await page.locator("#cart-total .cart-purchase-price").textContent(), /440/);
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
    assert.match(await page.locator("#cart-total .cart-purchase-price").textContent(), /200/);
    assert.equal(await page.locator("#cart-delivery-date").textContent(), formatDeliveryDate(deliveries.armtek.deliveryDateTo));
    await page.locator("#cart-tab-armtek").click();
    await page.keyboard.press("Escape");
    await page.locator("#cart-toggle").click();
    await page.waitForFunction(() => document.querySelector("#cart-tab-all").getAttribute("aria-selected") === "true");
  }, { deliveries, reducedMotion: "reduce" });
});

test("cart reference fields, aligned totals and tab-specific clear confirmations work without notes or links", async () => {
  await withCartPage(async (page, { orderCalls }) => {
    await page.locator("#results-body tr").first().locator(".cart-quantity").fill("2");
    await page.locator("#results-body .cart-offer-button").first().click();
    await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "2");
    await page.locator("#results-body .cart-offer-button").nth(1).click();
    await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "3");
    await page.locator("#cart-toggle").click();
    await page.waitForFunction(() => document.querySelectorAll("#cart-items tr[data-cart-item-id]").length === 2);
    await page.locator("#cart-select-all").check();
    assert.equal(await page.locator("#cart-modal header #cart-summary").count(), 0);
    assert.equal(await page.locator(".cart-test-note").count(), 0);
    assert.equal(await page.locator("#cart-items a").count(), 0);
    assert.deepEqual(await page.locator("#cart-modal .cart-table th").allTextContents(), ["", "Запчасть", "Наименование", "Поставщик", "Доставка", "Цена, ₽", "Кол-во", "Стоимость, ₽", "Удалить"]);
    assert.equal(await page.locator("#cart-items .cart-item-name").first().textContent(), "Сайлентблок балки моста");
    const firstRow = page.locator("#cart-items tr[data-cart-item-id]").first();
    assert.equal(await firstRow.locator(".cart-item-price .cart-price").textContent(), "135,00");
    assert.equal(await firstRow.locator(".cart-item-price .cart-purchase-price").textContent(), "100,00");
    assert.equal(await firstRow.locator(".cart-item-sum .cart-price").textContent(), "270,00");
    assert.equal(await firstRow.locator(".cart-item-sum .cart-purchase-price").textContent(), "200,00");
    assert.deepEqual(await firstRow.locator(".cart-price").evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).fontWeight)), ["700", "700"]);
    const priceStyle = await firstRow.locator(".cart-item-price").evaluate((cell) => {
      const retail = cell.querySelector(".cart-price");
      const purchase = cell.querySelector(".cart-purchase-price");
      return { retailSize: parseFloat(getComputedStyle(retail).fontSize), purchaseSize: parseFloat(getComputedStyle(purchase).fontSize),
        purchaseColor: getComputedStyle(purchase).color, purchaseWeight: getComputedStyle(purchase).fontWeight,
        retailBottom: retail.getBoundingClientRect().bottom, purchaseTop: purchase.getBoundingClientRect().top };
    });
    assert.ok(priceStyle.purchaseSize < priceStyle.retailSize);
    const mainPurchaseStyle = await page.locator("#results-body .main-result-purchase-price").first().evaluate((node) => ({
      color: getComputedStyle(node).color, size: parseFloat(getComputedStyle(node).fontSize), weight: getComputedStyle(node).fontWeight,
    }));
    assert.equal(priceStyle.purchaseColor, mainPurchaseStyle.color);
    assert.equal(priceStyle.purchaseSize, mainPurchaseStyle.size - 1);
    assert.equal(priceStyle.purchaseWeight, mainPurchaseStyle.weight);
    assert.ok(priceStyle.purchaseTop >= priceStyle.retailBottom);
    assert.equal(await page.locator("#cart-items .cart-item-part > span").count(), 4);
    assert.equal(await page.locator("#cart-summary").textContent(), "Количество: 3 шт. Выбрано к заказу: 3 шт.");
    assert.equal(await page.locator("#cart-total .cart-total-price").textContent(), "432,00 ₽");
    assert.equal(await page.locator("#cart-total .cart-purchase-price").textContent(), "320,00 ₽");
    assert.deepEqual(await page.locator("#cart-total .cart-purchase-price").evaluate((node) => ({
      color: getComputedStyle(node).color, size: parseFloat(getComputedStyle(node).fontSize), weight: getComputedStyle(node).fontWeight,
    })), { ...mainPurchaseStyle, size: mainPurchaseStyle.size - 1 });
    const tableBox = await page.locator(".cart-table-scroll").boundingBox();
    const summaryBox = await page.locator("#cart-summary").boundingBox();
    assert.ok(summaryBox.y >= tableBox.y + tableBox.height);
    const totals = await page.locator(".cart-footer__summary").evaluate((node) => {
      const amount = node.querySelector("#cart-total .cart-total-price");
      const date = node.querySelector("#cart-delivery-date");
      const style = (value) => {
        const css = getComputedStyle(value);
        return [css.fontSize, css.fontWeight, css.fontFamily, css.lineHeight];
      };
      return { amount: style(amount), date: style(date), amountTop: amount.getBoundingClientRect().top, dateTop: date.getBoundingClientRect().top };
    });
    assert.deepEqual(totals.amount, totals.date);
    assert.equal(totals.amountTop, totals.dateTop);
    assert.equal(await page.locator(".cart-footer__summary > span").nth(1).textContent(), "Дата поставки выбранных товаров");
    assert.equal(await page.locator("#cart-test-order").textContent(), "Оформить заказы");
    assert.equal(await page.locator("#cart-test-order").getAttribute("title"), null);
    const clearBox = await page.locator("#cart-clear").boundingBox();
    const closeBox = await page.locator("#cart-close").boundingBox();
    assert.ok(clearBox.x + clearBox.width < closeBox.x);
    assert.equal(await page.locator("#cart-clear img").evaluate((node) => node.complete && node.naturalWidth > 0), true);
    if (process.env.CART_REFERENCE_SCREENSHOT_PATH) await page.screenshot({ path: process.env.CART_REFERENCE_SCREENSHOT_PATH });
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileAmount = await page.locator("#cart-total .cart-total-price").boundingBox();
    const mobileDate = await page.locator("#cart-delivery-date").boundingBox();
    assert.equal(mobileAmount.y, mobileDate.y);
    assert.equal(await page.locator("#cart-total .cart-total-price").evaluate((node) => getComputedStyle(node).fontSize),
      await page.locator("#cart-delivery-date").evaluate((node) => getComputedStyle(node).fontSize));
    await page.locator("#cart-clear").click();
    assert.equal(await page.locator("#cart-clear-title").textContent(), "Очистить вкладку «Все»?");
    const confirmationBox = await page.locator("#cart-clear-confirm").boundingBox();
    assert.ok(confirmationBox.x >= 0 && confirmationBox.x + confirmationBox.width <= 390);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#cart-clear-confirm").open);
    assert.equal(await page.locator("#cart-badge").textContent(), "3");
    await page.locator("#cart-tab-armtek").click();
    assert.equal(await page.locator("#cart-test-order").textContent(), "Оформить заказ");
    await openCheckout(page);
    assert.equal(await page.locator(".cart-order-table .cart-item-price .cart-price").textContent(), "135,00");
    assert.equal(await page.locator(".cart-order-table .cart-item-price .cart-purchase-price").textContent(), "100,00");
    assert.equal(await page.locator(".cart-order-table .cart-item-sum .cart-price").textContent(), "270,00");
    assert.equal(await page.locator(".cart-order-table .cart-item-sum .cart-purchase-price").textContent(), "200,00");
    assert.deepEqual(await page.locator(".cart-order-table .cart-price").evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).fontWeight)), ["700", "700"]);
    assert.deepEqual(await page.locator(".cart-order-table .cart-purchase-price").first().evaluate((node) => ({
      color: getComputedStyle(node).color, size: parseFloat(getComputedStyle(node).fontSize), weight: getComputedStyle(node).fontWeight,
    })), { ...mainPurchaseStyle, size: mainPurchaseStyle.size - 1 });
    assert.match(await page.locator("#cart-order-total .cart-purchase-price").textContent(), /200/);
    assert.equal(await page.locator("#cart-order-total .cart-total-price").textContent(), "270,00 ₽");
    assert.deepEqual(await page.locator("#cart-order-total .cart-purchase-price").evaluate((node) => ({
      color: getComputedStyle(node).color, size: parseFloat(getComputedStyle(node).fontSize), weight: getComputedStyle(node).fontWeight,
    })), { ...mainPurchaseStyle, size: mainPurchaseStyle.size - 1 });
    await page.locator("#cart-order-cancel").click();
    assert.equal(orderCalls.length, 0);
    await page.locator("#cart-tab-part-kom").click();
    assert.equal(await page.locator("#cart-badge").textContent(), "3");
    await page.locator("#cart-clear").click();
    assert.equal(await page.locator("#cart-clear-title").textContent(), "Очистить вкладку «PartKOM»?");
    await page.locator("#cart-clear-cancel").click();
    assert.equal(await page.locator("#cart-badge").textContent(), "3");
    await page.locator("#cart-clear").click();
    await page.locator("#cart-clear-accept").click();
    await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "2");
    assert.equal(await page.locator("#cart-tab-part-kom").count(), 0);
    assert.equal(await page.locator("#cart-items .cart-item-supplier").textContent(), "ArmtekТестовый склад");
    assert.equal(await page.locator("#cart-summary").textContent(), "Количество: 2 шт. Выбрано к заказу: 2 шт.");
    await page.locator("#cart-clear").click();
    assert.equal(await page.locator("#cart-clear-title").textContent(), "Очистить вкладку «Все»?");
    await page.locator("#cart-clear-accept").click();
    await page.waitForFunction(() => document.querySelector("#cart-toggle").hidden);
    assert.equal(await page.locator("#cart-summary").textContent(), "Количество: 0 шт. Выбрано к заказу: 0 шт.");
    assert.equal(await page.locator("#cart-clear").isDisabled(), true);
    await page.reload();
    await page.waitForLoadState("networkidle");
    assert.equal(await page.locator("#cart-toggle").isVisible(), false);
  }, { title: "Сайлентблок балки моста", reducedMotion: "reduce", deliveries: {
    armtek: { deliveryDate: "2028-03-10T12:00:00Z", deliveryDateTo: "2028-03-12T12:00:00Z" },
    partkom: { deliveryDate: "2028-03-11T12:00:00Z", deliveryDateTo: "2028-03-14T12:00:00Z" },
  } });
});

test("cart clear confirmation rejects a cart changed after the user reviewed it", async () => {
  await withCartPage(async (page) => {
    await page.locator("#results-body .cart-offer-button").first().click();
    await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "1");
    await page.locator("#cart-toggle").click();
    await page.waitForFunction(() => document.querySelectorAll("#cart-items tr[data-cart-item-id]").length === 1);
    await page.locator("#cart-clear").click();
    await page.evaluate(async () => {
      const cart = await (await fetch("/api/cart")).json();
      const response = await fetch(`/api/cart/items/${cart.items[0].id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: cart.revision, quantity: 2 }) });
      if (!response.ok) throw new Error("Fixture update failed");
    });
    await page.locator("#cart-clear-accept").click();
    await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "2");
    assert.match(await page.locator("#cart-status").textContent(), /Корзина изменилась/);
    assert.equal(await page.locator("#cart-items tr[data-cart-item-id]").count(), 1);
  }, { reducedMotion: "reduce" });
});

test("four supplier checkout requires confirmation, details and removes confirmed goods", async () => {
  await withCartPage(async (page, { orderCalls }) => {
    const posts = [];
    page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/cart/order") posts.push(request); });
    for (let index = 0; index < 4; index++) {
      assert.equal(await page.locator("#results-body .cart-offer-button").nth(index).isEnabled(), true);
      if (index === 0) await page.locator("#results-body .cart-quantity").first().fill("2");
      await page.locator("#results-body .cart-offer-button").nth(index).click();
      await page.waitForFunction((count) => document.querySelector("#cart-badge").textContent === String(count), index + 2);
    }
    await page.locator("#cart-toggle").click();
    await page.waitForFunction(() => document.querySelectorAll("#cart-tabs .cart-tab").length === 5);
    await openCheckout(page);
    assert.equal(orderCalls.length, 0);
    assert.equal(posts.length, 0);
    assert.deepEqual(await page.locator(".cart-order-group h3").allTextContents(), ["Armtek", "PartKOM", "Forum Auto", "Rossko"]);
    assert.deepEqual((await page.locator(".cart-order-group-total .cart-purchase-price").allTextContents()).map((text) => text.replace(/\s/g, "")), ["200,00₽", "120,00₽", "120,00₽", "120,00₽"]);
    assert.deepEqual((await page.locator(".cart-order-group-total .cart-total-price").allTextContents()).map((text) => text.replace(/\s/g, "")), ["270,00₽", "162,00₽", "162,00₽", "162,00₽"]);
    assert.match(await page.locator("#cart-order-total .cart-purchase-price").textContent(), /560/);
    assert.equal(await page.locator("#cart-order-total .cart-total-price").textContent(), "756,00 ₽");
    assert.deepEqual(await page.locator(".cart-order-group-total .cart-purchase-price").evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).fontSize)), ["11px", "11px", "11px", "11px"]);
    assert.equal(await page.locator("#cart-order-groups tbody tr").count(), 4);
    assert.equal(await page.locator("#cart-order-groups img").count(), 0);
    assert.equal(await page.evaluate(() => window.cartXss), undefined);
    assert.equal(await page.locator("#cart-order-note").count(), 0);
    assert.match(await page.locator("#cart-order-intro").textContent(), /Внимательно проверьте товары/);
    assert.deepEqual(await page.locator("#cart-order-intro").evaluate((node) => ({
      color: getComputedStyle(node).color, weight: getComputedStyle(node).fontWeight,
    })), { color: "rgb(180, 35, 24)", weight: "800" });
    assert.equal(await page.locator("#cart-order-accept").evaluate((node) => getComputedStyle(node).backgroundColor), "rgb(22, 137, 86)");
    assert.equal(await page.locator("#cart-order-fields").count(), 0);
    await page.locator("#cart-order-cancel").click();
    assert.equal(posts.length, 0);
    await page.waitForFunction(() => document.activeElement?.id === "cart-test-order");
    assert.equal(await page.locator("#cart-test-order").evaluate((node) => node === document.activeElement), true);
    await openCheckout(page);
    await page.waitForFunction(() => document.querySelector("#cart-order-confirm").open);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#cart-order-confirm").open);
    assert.equal(await page.locator("#cart-order-confirm").isVisible(), false);
    assert.equal(await page.locator("#cart-modal").isVisible(), true);
    assert.equal(orderCalls.length, 0);
    await openCheckout(page);
    if (process.env.CART_ORDER_SCREENSHOT_PATH) await page.screenshot({ path: process.env.CART_ORDER_SCREENSHOT_PATH });
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await page.locator("#cart-order-confirm").boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 844);
    const firstGroup = page.locator(".cart-order-group").first();
    const tableBounds = await firstGroup.locator(".cart-table-scroll").boundingBox();
    for (const selector of [".cart-item-quantity", ".cart-item-price", ".cart-item-sum"]) {
      const cell = await firstGroup.locator(selector).boundingBox();
      assert.ok(cell.x >= tableBounds.x && cell.x + cell.width <= tableBounds.x + tableBounds.width);
    }
    for (let index = 0; index < 5; index++) {
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest("#cart-order-confirm"))), true);
    }
    if (process.env.CART_ORDER_MOBILE_SCREENSHOT_PATH) await page.screenshot({ path: process.env.CART_ORDER_MOBILE_SCREENSHOT_PATH });
    assert.equal(await page.locator("#cart-partkom-delivery").count(), 0);
    assert.equal(await page.locator("#cart-rossko-delivery, #cart-rossko-payment, #cart-rossko-name, #cart-rossko-phone").count(), 0);
    await page.locator("#cart-order-accept").click();
    await page.waitForFunction(() => document.querySelector("#cart-order-status").classList.contains("is-success"));
    assert.equal(orderCalls.length, 4);
    assert.equal(posts.length, 1);
    assert.deepEqual(orderCalls.map(([line]) => line.reference.supplier), ["armtek", "part-kom", "forum-auto", "rossko"]);
    assert.equal(await page.locator("#cart-order-accept").isVisible(), false);
    assert.match(await page.locator("#cart-order-status").textContent(), /Заказ успешно оформлен/);
    assert.equal(await page.locator("#cart-order-receipt p").count(), 4);
    assert.equal(await page.locator("#cart-badge").isVisible(), false);
    await page.locator("#cart-order-cancel").click();
    assert.match(await page.locator(".cart-empty").textContent(), /Корзина пуста/);
  }, { allSuppliers: true, reducedMotion: "reduce" });
});

test("checkout rejects a changed reviewed cart and requires reviewing the new quantity", async () => {
  await withCartPage(async (page, { orderCalls }) => {
    await page.locator("#results-body .cart-offer-button").first().click();
    await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "1");
    await page.locator("#cart-toggle").click();
    await openCheckout(page);
    assert.match(await page.locator("#cart-order-total .cart-purchase-price").textContent(), /100/);
    await page.evaluate(async () => {
      const cart = await (await fetch("/api/cart")).json();
      const response = await fetch(`/api/cart/items/${cart.items[0].id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: cart.revision, quantity: 2 }) });
      if (!response.ok) throw new Error("Fixture update failed");
    });
    await page.locator("#cart-order-accept").click();
    await page.waitForFunction(() => document.querySelector("#cart-order-status").classList.contains("is-error"));
    assert.match(await page.locator("#cart-order-status").textContent(), /Корзина изменилась/);
    assert.equal(await page.locator("#cart-order-accept").isDisabled(), true);
    assert.equal(orderCalls.length, 0);
    await page.locator("#cart-order-cancel").click();
    await openCheckout(page);
    assert.match(await page.locator("#cart-order-total .cart-purchase-price").textContent(), /200/);
    assert.equal(await page.locator(".cart-order-table .cart-item-quantity").textContent(), "2");
    await page.locator("#cart-order-accept").click();
    await page.waitForFunction(() => document.querySelector("#cart-order-status").classList.contains("is-success"));
    assert.equal(orderCalls.length, 1);
    assert.equal(orderCalls[0][0].quantity, 2);
  }, { reducedMotion: "reduce" });
});

test("checkout displays a refreshed supplier price before the order is sent", async () => {
  await withCartPage(async (page, { orderCalls }) => {
    await page.locator("#results-body .cart-offer-button").first().click();
    await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "1");
    await page.locator("#cart-toggle").click();
    await openCheckout(page);
    assert.equal(await page.locator("#cart-order-note").count(), 0);
    assert.equal(await page.locator(".cart-order-table .cart-purchase-price").first().textContent(), "125,00");
    assert.equal(orderCalls.length, 0);
    await page.locator("#cart-order-accept").click();
    await page.waitForFunction(() => document.querySelector("#cart-order-status").classList.contains("is-success"));
    assert.equal(orderCalls[0][0].result.price, 125);
  }, { refreshedPrice: 125, reducedMotion: "reduce" });
});

test("opening the cart refreshes its offers and a supplier tab can order without refreshing again", async () => {
  await withCartPage(async (page, { refreshCalls, orderCalls }) => {
    await page.locator("#results-body .cart-offer-button").first().click();
    await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "1");
    await page.locator("#cart-toggle").click();
    await page.waitForFunction(() => document.querySelector("#cart-items .cart-purchase-price")?.textContent === "125,00");
    assert.equal(await page.locator("#cart-test-order").isDisabled(), true);
    assert.equal(refreshCalls.length, 1);
    await page.locator("#cart-tab-armtek").click();
    await openCheckout(page);
    assert.equal(refreshCalls.length, 1);
    assert.equal(orderCalls.length, 0);
    await page.locator("#cart-order-accept").click();
    await page.waitForFunction(() => document.querySelector("#cart-order-status").classList.contains("is-success"));
    assert.equal(orderCalls[0][0].result.price, 125);
  }, { refreshedPrice: 125 });
});

test("opening the cart blocks checkout until supplier offers finish refreshing", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  try {
    await withCartPage(async (page, { refreshCalls }) => {
      await page.locator("#results-body .cart-offer-button").first().click();
      await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "1");
      await page.locator("#cart-toggle").click();
      await page.waitForFunction(() => document.querySelector("#cart-status").textContent.includes("Обновляем предложения"));
      assert.equal(await page.locator("#cart-test-order").isDisabled(), true);
      release();
      await page.waitForFunction(() => !document.querySelector("#cart-select-all").disabled);
      await page.locator("#cart-select-all").check();
      assert.equal(await page.locator("#cart-test-order").isEnabled(), true);
      assert.equal(refreshCalls.length, 1);
      assert.equal(await page.locator("#cart-status").textContent(), "");
    }, { refreshGate: () => gate });
  } finally { release(); }
});

test("checkout blocks duplicate submission and Escape while the real request is pending", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  try {
    await withCartPage(async (page, { orderCalls }) => {
      await page.locator("#results-body .cart-offer-button").first().click();
      await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "1");
      await page.locator("#cart-toggle").click();
      await openCheckout(page);
      await page.locator("#cart-order-accept").click();
      await page.waitForFunction(() => document.querySelector("#cart-order-status").textContent === "Отправляем заказ поставщикам…");
      assert.equal(await page.locator("#cart-order-accept").isDisabled(), true);
      assert.equal(await page.locator("#cart-order-cancel").isDisabled(), true);
      await page.locator("#cart-order-accept").evaluate((node) => node.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#cart-order-confirm").isVisible(), true);
      release();
      await page.waitForFunction(() => document.querySelector("#cart-order-status").classList.contains("is-success"));
      assert.equal(orderCalls.length, 1);
    }, { reducedMotion: "reduce", testGate: () => gate });
  } finally { release(); }
});
