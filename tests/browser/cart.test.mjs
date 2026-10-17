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
import { CartError } from "../../src/backend/purchasing/cart-application-service.ts";
import { SupplierAuthError } from "../../src/backend/errors.ts";
import { parsePartKomOrderHistory } from "../../src/backend/suppliers/part-kom/part-kom-order.ts";
import { parseArmtekOrderHistory } from "../../src/backend/suppliers/armtek/armtek-order.ts";
import { parseRosskoOrderHistory } from "../../src/backend/suppliers/rossko/rossko-api-adapter.ts";

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
      partKomOrderHistory: options.partKomOrderHistory ?? (async () => ({ orders: [], limited: false })),
      supplierOrderHistory: options.supplierOrderHistory ?? (async () => ({ orders: [], limited: false })),
      listSupplierSessions: () => sessions,
      getApplicabilityApiKeyState: () => ({ configured: false, persistent: false, maskedKey: null }),
      getApplicabilityProxyState: () => ({ persistent: false, activeRouteId: null, proxies: [], directLimited: false,
        usage: { requestCount: 0 }, directUsage: { requestCount: 0, secondsUntilReset: null } }),
      getApplicabilityCachedBrands: () => [],
      listApplicabilitySavedArticles: () => ({ articles: [], brandCounts: [], hasMore: false }),
      streamSearch: async (query, emit) => {
        emit({ type: "search_started", article: query.article, suppliers });
        emit({ type: "result", result: offer("armtek", options.stock ?? 4, { supplier: "armtek", keyzak: "TEST01",
          ...(options.armtekReturnDays !== undefined ? { returnDays: options.armtekReturnDays } : {}) }, options.deliveries?.armtek, options.title) });
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
          if (lines[0].reference.supplier === "forum-auto" && options.forumAutoRefusal) {
            return { confirmed: [], rejected: [{ id: lines[0].id, message: options.forumAutoRefusal }] };
          }
          return { confirmed: lines.map((line) => ({ id: line.id, acceptedQuantity: line.quantity, orderIds: [`fixture-${line.reference.supplier}`],
            ...(line.reference.supplier === "part-kom" && options.partKomReceipt ? { partKomOrders: [{ orderNumber: "fixture-part-kom",
              quantity: line.quantity, ...options.partKomReceipt }] } : {}),
            ...(line.reference.supplier === "forum-auto" && options.forumAutoReceipt ? { forumAutoOrder: {
              orderId: "fixture-forum-auto", orderedQuantity: line.quantity, ...options.forumAutoReceipt } } : {}),
            ...(line.reference.supplier === "rossko" && options.rosskoReceipt ? { rosskoOrders: [{
              orderId: "fixture-rossko", quantity: line.quantity, ...options.rosskoReceipt }] } : {}),
            ...(line.reference.supplier === "armtek" && options.armtekReceipt ? { armtekOrders: [{
              orderId: "fixture-armtek", quantity: line.quantity, ...options.armtekReceipt }] } : {}) })), rejected: [] };
        },
      },
    };
    server = createAggregatorServer({ application, publicDir: resolve("src/frontend") });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_BROWSER_EXECUTABLE_PATH });
    const page = await browser.newPage({ viewport: { width: 1366, height: 850 }, reducedMotion: options.reducedMotion ?? "no-preference",
      timezoneId: options.timezoneId ?? (options.fixedTime ? "UTC" : undefined) });
    if (options.fixedTime) await page.clock.setFixedTime(new Date(options.fixedTime));
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.addInitScript((suppliers) => {
      localStorage.setItem("autoservice.supplierVisibility", JSON.stringify(suppliers));
      localStorage.setItem("autoservice.searchState", JSON.stringify({ activeTabId: "cart-test", tabs: [{ id: "cart-test", article: "A1", enabledSuppliers: suppliers, results: [] }] }));
    }, suppliers);
    await page.goto(origin);
    await page.locator('#armtek-auth-form[data-authorized="true"]').waitFor({ state: "attached" });
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
    await page.waitForFunction(() => document.querySelector("#cart-order-confirm").classList.contains("is-success"));
    assert.equal(orderCalls.length, 2);
    assert.equal(orderCalls[0][0].reference.keyzak, "TEST01");
    assert.equal(orderCalls[0][0].quantity, 3);
    assert.equal(orderCalls[1][0].reference.providerId, "202");
    assert.equal(await page.locator("#cart-status").textContent(), "");
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
    await page.waitForFunction(() => document.querySelector("#cart-order-confirm").classList.contains("is-success"));
    assert.deepEqual(orderCalls.map(([line]) => line.reference.supplier), ["part-kom"]);
    await page.locator("#cart-order-cancel").click();
    assert.equal(await page.locator("#cart-badge").textContent(), "1");
    assert.equal(await page.locator("#cart-items .cart-item-supplier").textContent(), "ArmtekТестовый склад");
    assert.equal(await page.locator("#cart-test-order").isDisabled(), true);
    await openCheckout(page);
    assert.equal(await page.locator("#cart-order-confirm").evaluate((node) => node.classList.contains("is-success")), false);
    assert.equal(await page.locator("#cart-order-confirm").evaluate((node) => getComputedStyle(node).borderTopColor), "rgba(0, 0, 0, 0)");
    assert.equal(await page.locator("#cart-order-title").textContent(), "Подтверждение заказа");
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
    await page.waitForFunction(() => document.querySelector("#cart-order-confirm").classList.contains("is-success"));
    const receipt = page.locator(".cart-partkom-receipt");
    assert.equal(await receipt.count(), 1);
    assert.match(await receipt.textContent(), /fixture-part-kom/);
    assert.match(await receipt.textContent(), /Принят в работу/);
    assert.equal(await receipt.locator("dt", { hasText: "Дата заказа" }).evaluate((node) => node.nextElementSibling.textContent), "15.10.2026 12:33");
    assert.equal(await receipt.locator("dt", { hasText: "Ожидаемый срок" }).evaluate((node) => node.nextElementSibling.textContent), "18.10.2026 02:41");
    assert.equal(await receipt.locator("dt", { hasText: "Гарантированный срок" }).evaluate((node) => node.nextElementSibling.textContent), "21.10.2026 07:01");
    assert.match(await receipt.textContent(), /120,00/);
    assert.equal(await receipt.locator("img").count(), 0);
    assert.equal(await page.evaluate(() => window.cartXss), undefined);
    assert.equal(await page.locator("#cart-badge").isVisible(), false);
    if (process.env.CART_ORDER_RESULT_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.CART_ORDER_RESULT_SCREENSHOT_DIR, "order-result-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await receipt.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
    if (process.env.CART_ORDER_RESULT_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.CART_ORDER_RESULT_SCREENSHOT_DIR, "order-result-mobile.png") });
  }, { reducedMotion: "reduce", partKomReceipt: { orderDate: "2026-10-15 12:33:00", detailNum: "A1", maker: "TEST",
    description: "Деталь <img src=x onerror=window.cartXss=1>", price: 120, expectedDate: "2026-10-18 02:41:00",
    guaranteedDate: "2026-10-21 07:01:00", stateTxt: "Принят в работу", refusalCount: 0, storeCount: 0,
    releaseCount: 0, comment: "Проверено" } });
});

test("successful Forum Auto checkout displays the supplier order details", async () => {
  await withCartPage(async (page) => {
    await page.locator("#results-body .cart-offer-button").nth(2).click();
    await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "1");
    await page.locator("#cart-toggle").click();
    await openCheckout(page);
    await page.locator("#cart-order-accept").click();
    await page.waitForFunction(() => document.querySelector("#cart-order-confirm").classList.contains("is-success"));
    const receipt = page.locator(".cart-forum-receipt");
    assert.equal(await receipt.count(), 1);
    assert.match(await receipt.textContent(), /fixture-forum-auto/);
    assert.match(await receipt.textContent(), /Отправлен на бронирование/);
    assert.equal(await receipt.locator("dt", { hasText: "Создан" }).evaluate((node) => node.nextElementSibling.textContent), "15.10.2026 12:30");
    assert.equal(await receipt.locator("dt", { hasText: "Доставка" }).evaluate((node) => node.nextElementSibling.textContent), "17.10.2026 09:00");
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

for (const supplier of ["rossko", "armtek"]) {
  test(`successful ${supplier} checkout displays the confirmed supplier order`, async () => {
    await withCartPage(async (page) => {
      await page.locator("#results-body .cart-offer-button").nth(supplier === "rossko" ? 3 : 0).click();
      await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "1");
      await page.locator("#cart-toggle").click();
      await openCheckout(page);
      await page.locator("#cart-order-accept").click();
      await page.waitForFunction(() => document.querySelector("#cart-order-confirm").classList.contains("is-success"));
      const receipt = page.locator(`.cart-${supplier}-receipt`);
      assert.equal(await receipt.count(), 1);
      assert.match(await receipt.textContent(), new RegExp(`fixture-${supplier}`));
      assert.match(await receipt.textContent(), /Создан|Комплектуется/);
      assert.equal(await receipt.locator("dt", { hasText: "Создан" }).evaluate((node) => node.nextElementSibling.textContent), supplier === "rossko" ? "15.10.2026 13:33" : "15.10.2026 13:46");
      assert.equal(await receipt.locator("dt", { hasText: "Срок доставки" }).evaluate((node) => node.nextElementSibling.textContent), "16.10.2026");
      assert.match(await receipt.textContent(), /120,00|100,00/);
      assert.equal(await receipt.locator("img").count(), 0);
      if (supplier === "armtek") assert.match(await receipt.textContent(), /Срок возврата не указан/);
      else assert.doesNotMatch(await receipt.textContent(), /Возврат/);
      assert.equal(await page.evaluate(() => window.cartXss), undefined);
      assert.equal(await page.locator("#cart-badge").isVisible(), false);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await receipt.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
    }, { allSuppliers: true, reducedMotion: "reduce",
      ...(supplier === "rossko" ? { rosskoReceipt: { status: "Комплектуется", createdAt: "15.10.2026 13:33:00",
        deliveryAt: "16.10.2026", price: 120, total: 120, deliveryType: "Курьерская доставка",
        deliveryAddress: "Тестовый адрес <img src=x onerror=window.cartXss=1>", paymentType: "Банковский платёж" } }
        : { armtekReceipt: { status: "Создан", createdAt: "15.10.2026 13:46", deliveryAt: "16.10.2026", price: 100, total: 100,
          deliveryType: "Доставка до клиента", deliveryAddress: "Тестовый адрес <img src=x onerror=window.cartXss=1>" } }) });
  });
}

for (const returnDays of [14, 0]) {
  test(`Armtek return terms (${returnDays} days) appear in confirmation and the matching history position`, async () => {
    const expected = returnDays === 0 ? "Возврат недоступен" : "Возврат: 14 дн.";
    await withCartPage(async (page) => {
      await page.locator("#results-body .cart-offer-button").first().click();
      await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "1");
      await page.locator("#cart-toggle").click();
      await openCheckout(page);
      await page.locator("#cart-order-accept").click();
      await page.waitForFunction(() => document.querySelector("#cart-order-confirm").classList.contains("is-success"));
      assert.ok((await page.locator(".cart-armtek-receipt").innerText()).includes(expected));
      assert.match(await page.locator(".cart-armtek-receipt").innerText(), /Условия предложения при оформлении заказа/);
      await page.locator("#cart-order-cancel").click();
      await page.locator("#cart-close").click();
      await page.locator("#history-toggle").click();
      await page.locator("#history-tab-armtek").click();
      await page.locator(".order-return-terms").first().waitFor();
      const terms = page.locator(".order-return-terms");
      assert.ok((await terms.nth(0).innerText()).includes(expected));
      assert.equal(await terms.nth(0).getAttribute("title"), "Условия предложения при оформлении заказа");
      assert.equal(await terms.nth(1).innerText(), "Срок возврата не указан");
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.locator(".history-card").evaluate((node) => node.scrollWidth <= node.clientWidth), true);
    }, { fixedTime: "2026-10-16T12:00:00Z", armtekReturnDays: returnDays,
      armtekReceipt: { positionId: "10", returnDays, status: "Создан" },
      supplierOrderHistory: async () => ({ orders: [{ number: "fixture-armtek", date: "2026-10-16", items: ["10", "20"].map((positionId) => ({
        positionId, article: "A1", brand: "TEST", title: "Тестовая деталь", quantity: 1, price: 100, status: "В работе",
        fulfillment: "processing", expectedDate: null, guaranteedDate: null, warehouse: null,
      })) }], limited: false }) });
  });
}

test("PartKOM weekend delivery stays unchanged and shows an amber warning throughout checkout and active history", async () => {
  await withCartPage(async (page) => {
    const partKomRow = page.locator("#results-body tr").nth(1);
    assert.match(await partKomRow.locator('[data-column="deliveryDate"]').innerText(), /Завтра/);
    const searchWarning = partKomRow.locator(".delivery-date--warning");
    assert.equal(await searchWarning.textContent(), "Завтра");
    assert.equal(await partKomRow.locator('[data-column="deliveryDate"] b').count(), 0);
    assert.doesNotMatch(await partKomRow.innerText(), /Выходной|уточните доставку/);
    assert.equal(await page.locator("#results-body tr").first().locator(".delivery-date--warning").count(), 0);
    assert.equal(await searchWarning.evaluate((node) => getComputedStyle(node).backgroundColor), "rgb(255, 244, 204)");
    assert.equal(await searchWarning.evaluate((node) => getComputedStyle(node).borderRadius), "7px");
    await partKomRow.locator(".cart-offer-button").click();
    await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "1");
    await page.locator("#cart-toggle").click();
    assert.equal(await page.locator("#cart-items .delivery-date--warning").textContent(), "Завтра");
    await openCheckout(page);
    assert.equal(await page.locator("#cart-order-groups .delivery-date--warning").textContent(), "Завтра");
    await page.locator("#cart-order-accept").click();
    await page.waitForFunction(() => document.querySelector("#cart-order-confirm").classList.contains("is-success"));
    assert.match(await page.locator(".cart-partkom-receipt").innerText(), /17.10.2026/);
    assert.equal(await page.locator(".cart-partkom-receipt .delivery-date--warning").textContent(), "17.10.2026");
    const guaranteedReceipt = page.locator(".cart-partkom-receipt dt", { hasText: "Гарантированный срок" });
    assert.equal(await guaranteedReceipt.evaluate((node) => node.nextElementSibling.textContent), "17.10.2026 05:00");
    assert.equal(await guaranteedReceipt.evaluate((node) => node.nextElementSibling.querySelector(".delivery-date--warning")), null);
    await page.locator("#cart-order-cancel").click();
    await page.locator("#cart-close").click();
    await page.locator("#history-toggle").click();
    await page.locator(".history-card").waitFor();
    assert.equal(await page.locator(".history-card .delivery-date--warning").textContent(), "17.10.2026");
    const guaranteedHistory = page.locator(".history-card tbody tr").first().locator("time");
    assert.equal(await guaranteedHistory.textContent(), "17.10.2026 05:00");
    assert.equal(await guaranteedHistory.evaluate((node) => node.classList.contains("delivery-date--warning")), false);
    assert.match(await page.locator(".history-card tbody tr").first().innerText(), /17.10.2026/);
    assert.equal(await page.locator(".history-card tbody tr").nth(1).locator(".delivery-date--warning").count(), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator(".history-card").evaluate((node) => node.scrollWidth <= node.clientWidth), true);
    assert.equal(await page.locator(".delivery-date--warning").last().evaluate((node) => node.scrollWidth <= node.clientWidth), true);
  }, { fixedTime: "2026-10-16T12:00:00Z", timezoneId: "Asia/Dubai",
    deliveries: { armtek: { deliveryDate: "2026-10-17T09:00:00Z" }, partkom: { deliveryDate: "2026-10-16T22:00:00Z" } },
    partKomReceipt: { expectedDate: "2026-10-17", guaranteedDate: "2026-10-17 05:00:00", stateTxt: "В работе" },
    partKomOrderHistory: async () => ({ orders: [{ number: "WEEKEND-1", date: "2026-10-16", items: ["processing", "delivered"].map((fulfillment) => ({
      article: "A1", brand: "TEST", title: "Тестовая деталь", quantity: 1, price: 120, status: "Статус позиции", fulfillment,
      expectedDate: "2026-10-17", guaranteedDate: "2026-10-17 05:00:00", warehouse: null,
    })) }], limited: false }) });
});

test("PartKOM Friday to Sunday range highlights only the unchanged date range on one line", async () => {
  await withCartPage(async (page) => {
    const row = page.locator("#results-body tr").nth(1);
    const date = row.locator(".delivery-date--warning");
    assert.equal(await date.textContent(), "16.10.2026 - 18.10.2026");
    assert.equal(await date.evaluate((node) => getComputedStyle(node).whiteSpace), "nowrap");
    assert.doesNotMatch(await row.innerText(), /Выходной|уточните доставку/);
    assert.equal(await row.locator('[data-column="deliveryDate"] b').count(), 0);
  }, { fixedTime: "2026-10-16T12:00:00Z", deliveries: { partkom: {
    deliveryDate: "2026-10-16T09:00:00Z", deliveryDateTo: "2026-10-18T09:00:00Z",
  } } });
});

test("PartKOM ranges extending into workdays have no highlight in search, checkout or history", async () => {
  await withCartPage(async (page) => {
    const row = page.locator("#results-body tr").nth(1);
    assert.equal(await row.locator(".delivery-date").textContent(), "17.10.2026 - 20.10.2026");
    assert.equal(await row.locator(".delivery-date--warning").count(), 0);
    await row.locator(".cart-offer-button").click();
    await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "1");
    await page.locator("#cart-toggle").click();
    assert.equal(await page.locator("#cart-items .delivery-date--warning").count(), 0);
    await openCheckout(page);
    assert.equal(await page.locator("#cart-order-groups .delivery-date--warning").count(), 0);
    await page.locator("#cart-order-accept").click();
    await page.waitForFunction(() => document.querySelector("#cart-order-confirm").classList.contains("is-success"));
    assert.equal(await page.locator(".cart-partkom-receipt .delivery-date--warning").count(), 0);
    await page.locator("#cart-order-cancel").click();
    await page.locator("#cart-close").click();
    await page.locator("#history-toggle").click();
    await page.locator(".history-card").waitFor();
    assert.equal(await page.locator(".history-card .delivery-date--warning").count(), 0);
  }, { fixedTime: "2026-10-16T12:00:00Z", deliveries: { partkom: {
    deliveryDate: "2026-10-17T09:00:00Z", deliveryDateTo: "2026-10-20T09:00:00Z",
  } }, partKomReceipt: { expectedDate: "2026-10-17", guaranteedDate: "2026-10-20" },
    partKomOrderHistory: async () => ({ orders: [{ number: "WORKDAYS-1", date: "2026-10-16", items: [{
      article: "A1", brand: "TEST", title: "Тестовая деталь", quantity: 1, price: 120, status: "В работе", fulfillment: "processing",
      expectedDate: "2026-10-17", guaranteedDate: "2026-10-20", warehouse: null,
    }] }], limited: false }) });
});

test("a verified absent Forum Auto order can be unlocked without sending another order", async () => {
  await withCartPage(async (page, { orderCalls }) => {
    await page.locator("#results-body .cart-offer-button").nth(2).click();
    await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "1");
    await page.locator("#cart-toggle").click();
    await openCheckout(page);
    await page.locator("#cart-order-accept").click();
    await page.waitForFunction(() => document.querySelector("#cart-order-status").classList.contains("is-error"));
    assert.equal(orderCalls.length, 1);
    await page.locator("#cart-order-cancel").click();
    await page.locator("#cart-tab-forum-auto").click();
    assert.equal(await page.locator("#cart-status").textContent(), "");
    assert.equal(await page.locator("#cart-items .cart-item-select").isDisabled(), true);
    await page.locator(".cart-resolve-button").click();
    assert.equal(await page.locator("#cart-resolve-accept").isDisabled(), true);
    await page.locator("#cart-resolve-checked").check();
    await page.locator("#cart-resolve-accept").click();
    await page.waitForFunction(() => !document.querySelector("#cart-resolve-confirm").open);
    assert.equal(await page.locator("#cart-items .cart-item-select").isEnabled(), true);
    assert.equal(await page.locator(".cart-resolve-button").count(), 0);
    assert.equal(orderCalls.length, 1);
  }, { allSuppliers: true, reducedMotion: "reduce", testGate: async () => { throw new Error("Connection lost"); } });
});

test("a definite Forum Auto refusal keeps the item selectable and names the failure", async () => {
  await withCartPage(async (page, { orderCalls }) => {
    await page.locator("#results-body .cart-offer-button").nth(2).click();
    await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "1");
    await page.locator("#cart-toggle").click();
    await openCheckout(page);
    await page.locator("#cart-order-accept").click();
    await page.waitForFunction(() => document.querySelector("#cart-order-status").classList.contains("is-error"));
    assert.equal(await page.locator("#cart-order-title").textContent(), "Заказ не оформлен");
    assert.equal(await page.locator("#cart-order-confirm").evaluate((node) => node.classList.contains("is-success")), false);
    assert.match(await page.locator("#cart-order-receipt").textContent(), /превышен доступный лимит/);
    assert.equal(await page.locator("#cart-order-receipt").evaluate((node) => getComputedStyle(node).backgroundColor), "rgb(255, 240, 238)");
    await page.locator("#cart-order-cancel").click();
    assert.equal(await page.locator("#cart-items .cart-item-select").isEnabled(), true);
    assert.equal(orderCalls.length, 1);
  }, { allSuppliers: true, reducedMotion: "reduce", forumAutoRefusal: "Forum Auto отклонил заказ: превышен доступный лимит." });
});

test("cart honors reduced motion, constrains focus and fits mobile viewport", async () => {
  await withCartPage(async (page) => {
    await page.locator("#history-toggle").click();
    await page.locator("#history-tab-armtek").click();
    await page.waitForFunction(() => document.querySelector("#history-results").textContent.includes("В выбранной истории Armtek заказов нет"));
    await page.locator("#history-close").click();
    await page.waitForFunction(() => !document.querySelector("#history-modal"));
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
    await page.waitForFunction(() => document.querySelector("#cart-order-confirm").classList.contains("is-success"));
    assert.equal(orderCalls.length, 4);
    assert.equal(posts.length, 1);
    assert.deepEqual(orderCalls.map(([line]) => line.reference.supplier), ["armtek", "part-kom", "forum-auto", "rossko"]);
    assert.equal(await page.locator("#cart-order-accept").isVisible(), false);
    assert.equal(await page.locator("#cart-order-status").textContent(), "");
    assert.equal(await page.locator("#cart-order-status").isVisible(), false);
    assert.equal(await page.locator("#cart-status").textContent(), "");
    assert.equal(await page.locator("#cart-order-title").textContent(), "Заказ");
    assert.deepEqual(await page.locator("#cart-order-confirm").evaluate((node) => ({
      color: getComputedStyle(node).borderTopColor, width: getComputedStyle(node).borderTopWidth,
    })), { color: "rgb(22, 137, 86)", width: "3px" });
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
    await page.waitForFunction(() => document.querySelector("#cart-order-confirm").classList.contains("is-success"));
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
    await page.waitForFunction(() => document.querySelector("#cart-order-confirm").classList.contains("is-success"));
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
    await page.waitForFunction(() => document.querySelector("#cart-order-confirm").classList.contains("is-success"));
    assert.equal(orderCalls[0][0].result.price, 125);
  }, { refreshedPrice: 125 });
});

test("opening the cart shows a centered blocking refresh state until supplier offers finish refreshing", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  try {
    await withCartPage(async (page, { refreshCalls }) => {
      await page.locator("#results-body .cart-offer-button").first().click();
      await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "1");
      await page.locator("#cart-toggle").click();
      const overlay = page.locator("#cart-refresh-overlay");
      await overlay.waitFor({ state: "visible" });
      assert.match(await overlay.textContent(), /Обновляем корзину/);
      const modalBounds = await page.locator("#cart-modal").boundingBox();
      const messageBounds = await page.locator(".cart-refresh-overlay__message").boundingBox();
      assert.ok(Math.abs(messageBounds.x + messageBounds.width / 2 - (modalBounds.x + modalBounds.width / 2)) < 2);
      assert.ok(Math.abs(messageBounds.y + messageBounds.height / 2 - (modalBounds.y + modalBounds.height / 2)) < 2);
      assert.equal(await page.locator("#cart-tabs").evaluate((element) => element.inert), true);
      assert.equal(await page.locator("#cart-close").evaluate((element) => element.closest("header").inert), true);
      assert.equal(await page.locator("#cart-test-order").isDisabled(), true);
      await page.keyboard.press("Tab");
      assert.equal(await page.locator("#cart-refresh-overlay").evaluate((element) => document.activeElement === element), true);
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#cart-modal").isVisible(), true);
      release();
      await overlay.waitFor({ state: "hidden" });
      assert.equal(await page.locator("#cart-tabs").evaluate((element) => element.inert), false);
      await page.locator("#cart-select-all").check();
      assert.equal(await page.locator("#cart-test-order").isEnabled(), true);
      assert.equal(refreshCalls.length, 1);
      assert.equal(await page.locator("#cart-status").textContent(), "");
    }, { refreshGate: () => gate });
  } finally { release(); }
});

test("a failed cart refresh restores controls and shows a safe error", async () => {
  await withCartPage(async (page) => {
    await page.locator("#results-body .cart-offer-button").first().click();
    await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "1");
    await page.locator("#cart-toggle").click();
    await page.waitForFunction(() => document.querySelector("#cart-status").textContent.includes("Обновление временно недоступно"));
    assert.equal(await page.locator("#cart-refresh-overlay").isVisible(), false);
    assert.equal(await page.locator("#cart-tabs").evaluate((element) => element.inert), false);
    await page.locator("#cart-close").click();
    assert.equal(await page.locator("#cart-modal").isVisible(), false);
  }, { refreshGate: () => { throw new CartError("Обновление временно недоступно", 503); } });
});

test("checkout also shows the blocking refresh state when cart data became stale", async () => {
  let release;
  let refreshCount = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  try {
    await withCartPage(async (page, { refreshCalls }) => {
      await page.locator("#results-body .cart-offer-button").first().click();
      await page.waitForFunction(() => document.querySelector("#cart-badge").textContent === "1");
      await page.locator("#cart-toggle").click();
      await page.waitForFunction(() => document.querySelector("#cart-refresh-overlay").hidden);
      assert.equal(refreshCalls.length, 1);
      await page.locator("#cart-select-all").check();
      await page.locator("#cart-items .cart-quantity").fill("2");
      await page.locator("#cart-items .cart-quantity").press("Tab");
      await page.waitForFunction(() => document.querySelector("#cart-summary").textContent.includes("2 шт."));
      await page.locator("#cart-test-order").click();
      await page.locator("#cart-refresh-overlay").waitFor({ state: "visible" });
      assert.equal(await page.locator("#cart-tabs").evaluate((element) => element.inert), true);
      assert.equal(refreshCalls.length, 2);
      release();
      await page.locator("#cart-order-confirm").waitFor({ state: "visible" });
      assert.equal(await page.locator("#cart-refresh-overlay").isVisible(), false);
    }, { refreshGate: () => ++refreshCount === 2 ? gate : undefined });
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
      await page.waitForFunction(() => document.querySelector("#cart-order-confirm").classList.contains("is-success"));
      assert.equal(orderCalls.length, 1);
    }, { reducedMotion: "reduce", testGate: () => gate });
  } finally { release(); }
});

test("order history shows one PartKOM list and supplier tabs without rendering supplier HTML", async () => {
  const calls = [];
  await withCartPage(async (page) => {
    await page.locator("#history-toggle").click();
    await page.locator(".history-card").waitFor();
    assert.match(await page.locator(".history-card__header").innerText(), /Заказ № ORDER-1/);
    assert.match(await page.locator(".history-card").innerText(), /В работе/);
    assert.equal(await page.locator(".history-card__ordered strong").innerText(), "15.10.2026 12:30");
    assert.equal(await page.locator(".history-card tbody td").nth(1).locator("strong").innerText(), "20.10.2026");
    assert.equal(await page.locator(".history-card img").count(), 0);
    assert.equal(await page.evaluate(() => window.historyXss), undefined);
    assert.equal(await page.locator("#history-archive, #history-current").count(), 0);
    await page.locator("#history-reload").click();
    await page.locator(".history-card").waitFor();
    await page.locator("#history-tab-rossko").click();
    await page.waitForFunction(() => document.querySelector("#history-results").textContent.includes("В выбранной истории Rossko заказов нет"));
    assert.equal(await page.locator("#history-toolbar").isVisible(), true);
    assert.equal(await page.locator("#history-archive").count(), 0);
    await page.locator("#history-tab-part-kom").click();
    await page.locator(".history-card").waitFor();
    await page.locator("#history-close").click();
    assert.equal(await page.locator("#history-toggle").evaluate((node) => node === document.activeElement), true);
    // Initial background check, opening, reload, and returning to PartKOM all use the current history.
    assert.deepEqual(calls, [false, false, false, false]);
  }, { partKomOrderHistory: async (archive) => {
    calls.push(archive);
    return { orders: archive ? [] : [{ number: "ORDER-1", date: "2026-10-15 12:30:00", items: [{ article: "A1",
      brand: "TEST", title: "<img src=x onerror=window.historyXss=1>", quantity: 2, price: 100,
      status: "В работе", fulfillment: "processing", expectedDate: "2026-10-20", guaranteedDate: null, warehouse: "Склад" }] }], limited: false };
  } });
});

test("history supplier tabs show common filters without explanatory notes and query Armtek by date", async () => {
  const calls = [];
  await withCartPage(async (page) => {
    await page.locator("#history-toggle").click();
    for (const [supplier, name] of [["armtek", "Armtek"], ["forum-auto", "Forum Auto"], ["rossko", "Rossko"]]) {
      await page.locator(`#history-tab-${supplier}`).click();
      await page.waitForFunction((name) => document.querySelector(".history-card__header small")?.textContent === name, name);
      assert.equal(await page.locator("#history-current, #history-archive").count(), 0);
      assert.equal(await page.locator("#history-period").isVisible(), true);
      assert.equal(await page.locator("#history-status-tabs").isVisible(), true);
      assert.equal(await page.locator("#history-reset").isVisible(), false);
      assert.equal(await page.locator("#history-status, #history-toolbar [type=submit]").count(), 0);
      assert.equal(await page.locator("#history-scope, .history-limit").count(), 0);
      assert.match(await page.locator(".history-card").innerText(), new RegExp(`Заказ № ${supplier}-1`));
      assert.equal(await page.locator(".history-card__ordered strong").innerText(), "15.10.2026 12:30");
      assert.equal(await page.locator(".history-card tbody td").nth(1).locator("strong").innerText(), "20.10.2026");
      assert.doesNotMatch(await page.locator(".history-card").innerText(), /Желаемая дата/);
      assert.equal(await page.locator(".history-card img").count(), 0);
      assert.equal(await page.evaluate(() => window.historyXss), undefined);
      if (supplier === "armtek") {
        await page.locator("#history-from").fill("2026-10-01");
        await page.locator("#history-to").fill("2026-10-15");
        await page.waitForFunction(() => document.querySelector(".history-card") !== null);
        assert.deepEqual(calls.at(-1), { supplier: "armtek", from: "2026-10-01", to: "2026-10-15" });
        const previousCalls = calls.length;
        await page.locator("#history-from").fill("2026-01-01");
        await page.locator(".history-message.is-error").waitFor();
        assert.match(await page.locator("#history-results").innerText(), /не более 93 дней/);
        assert.equal(calls.length, previousCalls);
      }
      if (supplier === "rossko") {
        assert.equal(await page.locator(".history-card__total").count(), 0);
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#history-tab-armtek").click();
    assert.equal(await page.locator("#history-toolbar").evaluate((node) => node.scrollWidth <= node.clientWidth), true);
  }, { fixedTime: "2026-10-15T12:00:00Z", supplierOrderHistory: async (query) => {
    calls.push(query);
    return { orders: [{ number: `${query.supplier}-1`, date: "2026-10-15 12:30:00", items: [{ article: "A1", brand: "TEST",
      title: "<img src=x onerror=window.historyXss=1>", quantity: 1.5, price: 100, status: "В работе", fulfillment: "processing",
      expectedDate: "2026-10-20", guaranteedDate: null, warehouse: null }] }], limited: query.supplier === "rossko" };
  } });
});

test("history filters all suppliers by inclusive order dates and any item status, restores tabs and resets", async () => {
  const calls = [];
  const order = (number, date, states = ["cancelled"]) => ({ number, date, items: states.map((fulfillment) => ({
    article: "A1", brand: "TEST", title: "Тестовая деталь", quantity: 1, price: 100, status: null, fulfillment,
    expectedDate: "2026-12-01", guaranteedDate: null, warehouse: null,
  })) });
  const history = { limited: true, orders: [
    order("START-MIXED", "2026-10-15 00:00:00", ["processing", "cancelled", "delivered"]),
    order("END", "2026-10-16 23:59:59"), order("BEFORE", "2026-10-14 23:59:59"),
    order("AFTER", "2026-10-17 00:00:00"), order("UNDATED", null), order("INVALID-DATE", "2026-02-30"),
    order("TRANSIT", "2026-10-15", ["in_transit"]), order("READY", "2026-10-16", ["ready"]),
  ] };
  await withCartPage(async (page) => {
    const headings = (numbers) => numbers.map((number) => `Заказ № ${number}`);
    const shown = async (numbers) => {
      await page.waitForFunction((expected) => JSON.stringify([...document.querySelectorAll(".history-card h3")]
        .map((node) => node.textContent)) === JSON.stringify(expected), headings(numbers));
    };
    await page.locator("#history-toggle").click();
    for (const [supplier, name] of [["part-kom", "PartKOM"], ["armtek", "Armtek"], ["forum-auto", "Forum Auto"], ["rossko", "Rossko"]]) {
      if (supplier !== "part-kom") await page.locator(`#history-tab-${supplier}`).click();
      await page.waitForFunction((name) => document.querySelector(".history-card__header small")?.textContent === name, name);
      assert.equal(await page.locator("#history-status-tabs [role=tab]").count(), 7);
      assert.equal(await page.locator("#history-status-attention").count(), 0);
      assert.equal(await page.locator("#history-scope, .history-limit").count(), 0);
      assert.doesNotMatch(await page.locator("#history-results").innerText(), /Показана ограниченная|не более 93|Активные заказы|Последние 500|Для полной истории/);
      const toolbar = await page.locator("#history-toolbar").boundingBox();
      const firstCard = await page.locator(".history-card").first().boundingBox();
      assert.ok(toolbar.y + toolbar.height <= firstCard.y);
      await page.locator("#history-from").fill("2026-10-15");
      await page.locator("#history-to").fill("2026-10-16");
      await page.locator("#history-status-cancelled").click();
      await shown(["END", "START-MIXED"]);
      assert.equal(await page.locator(".history-card").filter({ has: page.locator("h3", { hasText: "START-MIXED" }) }).locator("tbody tr").count(), 3);
      assert.equal(await page.locator(".history-card__total").count(), 0);
      const supplierCall = calls.findLast((call) => call.supplier === supplier);
      if (supplier === "armtek") assert.deepEqual(supplierCall, { supplier, from: "2026-10-15", to: "2026-10-16" });
      else assert.deepEqual(supplierCall, { supplier });
      const beforeStatus = calls.length;
      await page.locator("#history-status-active").click();
      await shown(["READY", "START-MIXED", "TRANSIT"]);
      await page.locator("#history-status-returned").click();
      await page.waitForFunction(() => document.querySelector("#history-results").textContent.includes("По выбранным фильтрам заказов нет"));
      assert.equal(calls.length, beforeStatus);
      await page.locator("#history-reset").click();
      await page.locator(".history-card").first().waitFor();
      assert.equal(await page.locator("#history-status-all").getAttribute("aria-selected"), "true");
      assert.equal(await page.locator("#history-reset").isVisible(), false);
      assert.equal(await page.locator("#history-from").inputValue(), supplier === "armtek" ? "2026-09-16" : "");
      assert.equal(await page.locator("#history-to").inputValue(), supplier === "armtek" ? "2026-10-15" : "");
      assert.equal(await page.locator(".history-card h3", { hasText: "UNDATED" }).count(), supplier === "armtek" ? 0 : 1);
      await page.locator("#history-from").fill("2026-10-17");
      await page.locator("#history-to").fill("2026-10-15");
      const beforeInvalid = calls.length;
      await page.locator(".history-message.is-error").waitFor();
      assert.match(await page.locator("#history-results").innerText(), /начала не должна быть позже/);
      assert.equal(calls.length, beforeInvalid);
      await page.locator("#history-from").fill("10000-10-15");
      await page.waitForFunction(() => document.querySelector("#history-results").textContent.includes("Укажите корректные даты"));
      assert.equal(calls.length, beforeInvalid);
      await page.locator("#history-reset").click();
      await page.locator(".history-card").first().waitFor();
      if (supplier !== "armtek") {
        await page.locator("#history-status-cancelled").click();
        await page.locator("#history-from").fill("2026-10-16");
        await shown(["AFTER", "END"]);
        await page.locator("#history-from").fill("");
        await page.locator("#history-to").fill("2026-10-15");
        await shown(["START-MIXED", "BEFORE"]);
      }
    }
    await page.locator("#history-tab-part-kom").click();
    await page.locator(".history-card").first().waitFor();
    assert.equal(await page.locator("#history-to").inputValue(), "2026-10-15");
    assert.equal(await page.locator("#history-status-cancelled").getAttribute("aria-selected"), "true");
    assert.deepEqual(await page.locator(".history-card h3").allTextContents(), headings(["START-MIXED", "BEFORE"]));
    for (const width of [800, 390]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.locator("#history-toolbar").evaluate((node) => node.scrollWidth <= node.clientWidth), true);
      assert.equal(await page.locator("#history-modal").evaluate((node) => node.scrollWidth <= node.clientWidth), true);
    }
  }, { fixedTime: "2026-10-15T12:00:00Z", partKomOrderHistory: async () => { calls.push({ supplier: "part-kom" }); return history; },
    supplierOrderHistory: async (query) => { calls.push(query); return history; } });
});

test("arriving today tab uses local delivery dates, excludes finished items and works across suppliers", async () => {
  const calls = [];
  const item = (expectedDate, fulfillment = "in_transit", guaranteedDate = null) => ({
    article: "A1", brand: "TEST", title: "Тестовая деталь", quantity: 1, price: 100, status: null, fulfillment,
    expectedDate, guaranteedDate, warehouse: null,
  });
  const order = (number, items, date = "2026-10-14 12:30:00") => ({ number, date, items });
  const history = { limited: false, orders: [
    order("EARLY", [item("2026-10-15 00:10:00", "processing")], "2026-10-13 12:30:00"),
    order("TRANSIT", [item("2026-10-15")]), order("READY", [item("2026-10-15T23:59:59", "ready")]),
    order("PARTIAL", [item("2026-10-15 12:00", "partial")]), order("UNKNOWN", [item("2026-10-15", "unknown")]),
    order("MIXED", [item("2026-10-15"), item("2026-10-15", "delivered")]),
    order("YESTERDAY", [item("2026-10-14")]), order("TOMORROW", [item("2026-10-16")]),
    order("NO-DATE", [item(null, "in_transit", "2026-10-15")]),
    order("INVALID", [item("2026-10-15T25:61:00"), item("2026-10-15 invalid")]),
    order("FINISHED", ["delivered", "cancelled", "returned"].map((state) => item("2026-10-15", state))),
    order("MISMATCH", [item("2026-10-15", "delivered"), item("2026-10-16", "processing")]),
  ] };
  await withCartPage(async (page) => {
    const expected = ["TRANSIT", "READY", "PARTIAL", "UNKNOWN", "MIXED", "EARLY"];
    const shown = async (numbers) => page.waitForFunction((expected) => JSON.stringify([...document.querySelectorAll(".history-card h3")]
      .map((node) => node.textContent)) === JSON.stringify(expected), numbers.map((number) => `Заказ № ${number}`));
    await page.locator("#history-toggle").click();
    assert.equal(await page.locator("#history-status-today").textContent(), "Придут сегодня");
    for (const [supplier, name] of [["part-kom", "PartKOM"], ["armtek", "Armtek"], ["forum-auto", "Forum Auto"], ["rossko", "Rossko"]]) {
      if (supplier !== "part-kom") await page.locator(`#history-tab-${supplier}`).click();
      await page.waitForFunction((name) => !document.querySelector(".history-loading")
        && document.querySelector(".history-card__header small")?.textContent === name, name);
      const before = calls.length;
      await page.locator("#history-status-today").click();
      await shown(expected);
      assert.equal(await page.locator("#history-status-today").getAttribute("aria-selected"), "true");
      assert.equal(await page.locator("#history-reset").isVisible(), true);
      assert.equal(await page.locator(".history-card").filter({ has: page.locator("h3", { hasText: "MIXED" }) }).locator("tbody tr").count(), 2);
      assert.equal(calls.length, before);
    }
    await page.locator("#history-tab-all").click();
    await page.waitForFunction(() => !document.querySelector(".history-loading") && document.querySelectorAll(".history-card").length === 48);
    const before = calls.length;
    await page.locator("#history-status-today").click();
    await page.waitForFunction(() => document.querySelectorAll(".history-card").length === 24);
    for (const name of ["PartKOM", "Armtek", "Forum Auto", "Rossko"]) {
      assert.equal(await page.locator(".history-card__header small", { hasText: new RegExp(`^${name}$`) }).count(), 6);
    }
    assert.equal(calls.length, before);
    if (process.env.HISTORY_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.HISTORY_SCREENSHOT_DIR, "history-today-desktop.png") });
    await page.locator("#history-from").fill("2026-10-14");
    await page.waitForFunction(() => !document.querySelector(".history-loading") && document.querySelectorAll(".history-card").length === 20);
    assert.equal(await page.locator(".history-card h3", { hasText: "EARLY" }).count(), 0);
    await page.locator("#history-reset").click();
    await page.waitForFunction(() => !document.querySelector(".history-loading") && document.querySelectorAll(".history-card").length === 48);
    assert.equal(await page.locator("#history-reset").isVisible(), false);
    assert.equal(await page.locator("#history-status-all").getAttribute("aria-selected"), "true");
    await page.locator("#history-tab-part-kom").click();
    await shown(expected);
    await page.clock.setFixedTime(new Date("2026-10-15T22:00:00Z"));
    await page.locator("#history-status-today").click();
    await shown(["TOMORROW", "MISMATCH"]);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator("#history-status-tabs").evaluate((node) => node.scrollWidth <= node.clientWidth), true);
    if (process.env.HISTORY_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.HISTORY_SCREENSHOT_DIR, "history-today-mobile.png") });
  }, { fixedTime: "2026-10-14T22:00:00Z", timezoneId: "Asia/Dubai",
    partKomOrderHistory: async () => { calls.push({ supplier: "part-kom" }); return history; },
    supplierOrderHistory: async (query) => { calls.push(query); return history; } });
});

test("combined history progressively loads all suppliers, groups statuses and filters dates without redundant requests", async () => {
  const calls = [];
  const order = (number, states, date = "2026-10-15 12:30:00") => ({ number, date,
    items: states.map((fulfillment) => ({ article: "A1", brand: "TEST", title: "Тестовая деталь", quantity: 1, price: 100,
      status: null, fulfillment, expectedDate: null, guaranteedDate: null, warehouse: null })) });
  const histories = {
    "part-kom": { limited: false, orders: [order("SHARED", ["processing"], "2026-10-14"),
      order("CANCEL-MIXED", ["cancelled", "delivered"]), order("UNKNOWN", ["unknown"])] },
    armtek: { limited: false, orders: [order("MOVING", ["in_transit"]), order("PARTIAL", ["partial"])] },
    "forum-auto": { limited: false, orders: [order("WAREHOUSE", ["ready"]), order("RETURN", ["returned"])] },
    rossko: { limited: true, orders: [order("SHARED", ["delivered"]), order("UNAVAILABLE", ["cancelled"])] },
  };
  let releaseForum;
  const forumGate = new Promise((resolve) => { releaseForum = resolve; });
  await withCartPage(async (page) => {
    const shown = async (numbers) => page.waitForFunction((expected) => JSON.stringify([...document.querySelectorAll(".history-card h3")]
      .map((node) => node.textContent)) === JSON.stringify(expected), numbers.map((number) => `Заказ № ${number}`));
    await page.locator("#history-toggle").click();
    await page.locator(".history-card").first().waitFor();
    assert.deepEqual(await page.locator("#history-tabs [role=tab]").allTextContents(), ["PartKOM", "Armtek", "Forum Auto", "Rossko", "Все поставщики"]);
    assert.equal(await page.locator("#history-tab-all").evaluate((node) => node.classList.contains("history-tab--all")), true);
    await page.locator("#history-tab-all").click();
    try {
      await page.waitForFunction(() => document.querySelectorAll(".history-card").length === 7);
      assert.match(await page.locator(".history-loading").innerText(), /Forum Auto/);
      assert.equal(await page.locator(".history-card__header small", { hasText: "Forum Auto" }).count(), 0);
    } finally { releaseForum(); }
    await shown(["CANCEL-MIXED", "UNKNOWN", "MOVING", "PARTIAL", "WAREHOUSE", "RETURN", "SHARED", "UNAVAILABLE", "SHARED"]);
    assert.equal(await page.locator(".history-item-status .history-status--unknown").count(), 1);
    assert.equal(await page.locator("#history-status-attention").count(), 0);
    assert.deepEqual(await page.locator(".history-card__header small").allTextContents(),
      ["PartKOM", "PartKOM", "Armtek", "Armtek", "Forum Auto", "Forum Auto", "Rossko", "Rossko", "PartKOM"]);
    const rossko = page.locator(".history-card").filter({ has: page.locator("small", { hasText: /^Rossko$/ }) });
    assert.equal(await rossko.locator(".history-card__total").count(), 0);
    const partkom = page.locator(".history-card").filter({ has: page.locator("small", { hasText: /^PartKOM$/ }) });
    assert.equal(await partkom.locator(".history-card__total").count(), 3);
    assert.equal(await page.locator("#history-reset").isVisible(), false);
    assert.equal(await page.locator("#history-from").inputValue(), "");
    assert.deepEqual(calls.find((query) => query.supplier === "armtek"), { supplier: "armtek", from: "2026-09-16", to: "2026-10-15" });
    const beforeStatus = calls.length;
    for (const [group, expected] of [
      ["active", ["MOVING", "WAREHOUSE", "SHARED"]], ["partial", ["PARTIAL"]], ["cancelled", ["CANCEL-MIXED", "UNAVAILABLE"]],
      ["delivered", ["CANCEL-MIXED", "SHARED"]], ["returned", ["RETURN"]],
    ]) {
      await page.locator(`#history-status-${group}`).click();
      await shown(expected);
      assert.equal(await page.locator(`#history-status-${group}`).getAttribute("aria-selected"), "true");
      assert.equal(await page.locator("#history-reset").isVisible(), true);
      if (group === "cancelled") assert.equal(await page.locator(".history-card tbody tr").count(), 3);
    }
    assert.equal(calls.length, beforeStatus);
    await page.locator("#history-status-all").click();
    assert.equal(await page.locator("#history-reset").isVisible(), false);
    await page.locator("#history-from").fill("2026-10-15");
    await page.waitForFunction(() => !document.querySelector(".history-loading") && document.querySelectorAll(".history-card").length === 8);
    assert.equal(calls.length, beforeStatus + 1);
    assert.equal(calls.at(-1).supplier, "armtek");
    await page.locator("#history-to").fill("2026-10-16");
    await page.waitForFunction(() => !document.querySelector(".history-loading") && document.querySelectorAll(".history-card").length === 8);
    assert.deepEqual(calls.at(-1), { supplier: "armtek", from: "2026-10-15", to: "2026-10-16" });
    const beforeInvalidPeriod = calls.length;
    await page.locator("#history-from").fill("2026-01-01");
    await page.locator(".history-message.is-error").waitFor();
    assert.match(await page.locator(".history-message.is-error").innerText(), /Armtek:.*не более 93 дней/);
    assert.equal(calls.length, beforeInvalidPeriod);
    assert.equal(await page.locator(".history-card").count(), 7);
    await page.locator("#history-reset").click();
    await page.waitForFunction(() => document.querySelectorAll(".history-card").length === 9);
    assert.equal(await page.locator("#history-reset").isVisible(), false);
    if (process.env.HISTORY_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.HISTORY_SCREENSHOT_DIR, "history-all-desktop.png") });
    await page.locator("#history-status-cancelled").click();
    await page.locator("#history-tab-part-kom").click();
    await page.waitForFunction(() => document.querySelectorAll(".history-card").length === 3);
    assert.equal(await page.locator("#history-status-all").getAttribute("aria-selected"), "true");
    await page.locator("#history-tab-all").click();
    await shown(["CANCEL-MIXED", "UNAVAILABLE"]);
    await page.waitForFunction(() => !document.querySelector(".history-loading"));
    assert.equal(await page.locator("#history-status-cancelled").getAttribute("aria-selected"), "true");
    for (const width of [800, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const selector of ["#history-tabs", "#history-status-tabs", "#history-toolbar", "#history-modal"]) {
        assert.equal(await page.locator(selector).evaluate((node) => node.scrollWidth <= node.clientWidth), true);
      }
      if (process.env.HISTORY_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.HISTORY_SCREENSHOT_DIR, `history-all-${width}.png`) });
    }
  }, { fixedTime: "2026-10-15T12:00:00Z", partKomOrderHistory: async () => { calls.push({ supplier: "part-kom" }); return histories["part-kom"]; },
    supplierOrderHistory: async (query) => { calls.push(query); if (query.supplier === "forum-auto") await forumGate; return histories[query.supplier]; } });
});

test("combined history retains successful suppliers when one is unauthorized and another returns malformed data", async () => {
  const history = { limited: false, orders: [{ number: "REAL-FIXTURE", date: "2026-10-15", items: [{ article: "A1", brand: "TEST",
    title: "<img src=x onerror=window.historyXss=1>", quantity: 1, price: 100, status: null, fulfillment: "cancelled",
    expectedDate: null, guaranteedDate: null, warehouse: null }] }] };
  await withCartPage(async (page) => {
    await page.route("**/api/order-history/armtek?*", (route) => route.fulfill({ status: 401, json: { message: "Авторизация недоступна." } }));
    await page.route("**/api/order-history/forum-auto", (route) => route.fulfill({ json: { unexpected: true } }));
    await page.locator("#history-toggle").click();
    await page.locator("#history-tab-all").click();
    await page.waitForFunction(() => !document.querySelector(".history-loading"));
    assert.equal(await page.locator(".history-message.is-error").count(), 2);
    assert.match(await page.locator("#history-results").innerText(), /Armtek: Авторизация недоступна/);
    assert.match(await page.locator("#history-results").innerText(), /Forum Auto вернул некорректную историю/);
    assert.deepEqual(await page.locator(".history-card__header small").allTextContents(), ["PartKOM", "Rossko"]);
    await page.locator("#history-status-cancelled").click();
    assert.equal(await page.locator(".history-card").count(), 2);
    assert.equal(await page.locator(".history-message.is-error").count(), 2);
    assert.equal(await page.locator(".history-card img").count(), 0);
    assert.equal(await page.evaluate(() => window.historyXss), undefined);
    await page.keyboard.press("Escape");
    await page.locator("#history-modal").waitFor({ state: "detached" });
    assert.equal(await page.locator("#history-modal").count(), 0);
  }, { fixedTime: "2026-10-15T12:00:00Z", partKomOrderHistory: async () => history, supplierOrderHistory: async () => history });
});

test("combined history discards an older Armtek date response while retaining the other suppliers", async () => {
  const history = (number) => ({ limited: false, orders: [{ number, date: "2026-10-15", items: [{ article: "A1", brand: "TEST",
    title: "Тестовая деталь", quantity: 1, price: 100, status: null, fulfillment: "processing", expectedDate: null,
    guaranteedDate: null, warehouse: null }] }] });
  await withCartPage(async (page) => {
    let releaseOlder;
    const gate = new Promise((resolve) => { releaseOlder = resolve; });
    let olderStarted;
    const started = new Promise((resolve) => { olderStarted = resolve; });
    let olderFinished;
    const finished = new Promise((resolve) => { olderFinished = resolve; });
    await page.route("**/api/order-history/armtek?*", async (route) => {
      const start = new URL(route.request().url()).searchParams.get("from");
      if (start === "2026-10-01") {
        olderStarted();
        await gate;
        try { await route.fulfill({ json: history("OLDER") }); } finally { olderFinished(); }
      } else await route.fulfill({ json: history(start === "2026-10-02" ? "NEWER" : "INITIAL") });
    });
    await page.locator("#history-toggle").click();
    await page.locator("#history-tab-all").click();
    await page.waitForFunction(() => document.querySelectorAll(".history-card").length === 4);
    try {
      await page.locator("#history-from").fill("2026-10-01");
      await started;
      assert.equal(await page.locator(".history-card").count(), 3);
      await page.locator("#history-from").fill("2026-10-02");
      await page.locator(".history-card h3", { hasText: "NEWER" }).waitFor();
    } finally { releaseOlder(); }
    await finished;
    assert.equal(await page.locator(".history-card").count(), 4);
    assert.equal(await page.locator(".history-card h3", { hasText: "OLDER" }).count(), 0);
    assert.equal(await page.locator(".history-card h3", { hasText: "NEWER" }).count(), 1);
    assert.deepEqual(await page.locator(".history-card__header small").allTextContents(), ["PartKOM", "Armtek", "Forum Auto", "Rossko"]);
    await page.locator("#history-tab-part-kom").click();
    await page.waitForFunction(() => document.querySelectorAll(".history-card").length === 1);
    assert.equal(await page.locator(".history-card__header small").innerText(), "PartKOM");
    await page.locator("#history-close").click();
    assert.equal(await page.locator("#history-modal").count(), 0);
  }, { fixedTime: "2026-10-15T12:00:00Z", partKomOrderHistory: async () => history("PARTKOM"),
    supplierOrderHistory: async (query) => history(query.supplier) });
});

test("history highlights fulfillment in every supplier and preserves mixed and partial orders", async () => {
  const row = { detailNum: "A1", maker: "TEST", description: "Тестовая деталь", quantity: 1, price: 100,
    orderDate: "2026-10-15 12:30:00", stateTxt: "Заказ передан в службу доставки. Сопроводительные документы подготовлены." };
  const history = parsePartKomOrderHistory([
    { ...row, orderNumber: "RECEIVED", releaseCount: 1, refusalCount: 0 },
    { ...row, orderNumber: "CANCELLED", refusalCount: 1 },
    { ...row, orderNumber: "MOVING", releaseCount: 0 },
    { ...row, orderNumber: "SUPPLIER", quantity: 2, releaseCount: 0, refusalCount: 0, storeCount: 0,
      stateTxt: "Заказ передан поставщику. Поставщик подтвердил наличие товара." },
    { ...row, orderNumber: "INITIAL", state: 0, stateTxt: "", releaseCount: 0, refusalCount: 0, storeCount: 0 },
    { ...row, orderNumber: "INBOUND", stateTxt: "Заказанный артикул в пути на склад ПартКом." },
    { ...row, orderNumber: "READY", storeCount: 1 },
    { ...row, orderNumber: "PARTIAL", quantity: 2, releaseCount: 1, refusalCount: 0 },
    { ...row, orderNumber: "MIXED", releaseCount: 1 },
    { ...row, orderNumber: "MIXED", detailNum: "B1", releaseCount: 0 },
    { ...row, orderNumber: "UNKNOWN", stateTxt: "Новый неизвестный статус", expectedDate: "2020-01-01" },
  ]);
  await withCartPage(async (page) => {
    const historyRequests = [];
    page.on("request", (request) => { if (request.url().includes("/api/order-history/part-kom")) historyRequests.push(request.url()); });
    await page.locator("#history-toggle").click();
    await page.locator('.history-card[data-fulfillment="delivered"]').waitFor();
    const received = page.locator(".history-card").filter({ has: page.locator("h3", { hasText: /^Заказ № RECEIVED$/ }) });
    assert.match(await received.locator(".history-card__states").innerText(), /✓\s*Получен/);
    assert.match(await received.locator(".history-item-status").innerText(), /Получен.*Выдано 1 из 1/s);
    assert.doesNotMatch(await received.innerText(), /передан в службу доставки/);
    assert.equal(await received.evaluate((node) => getComputedStyle(node).borderLeftColor), "rgb(35, 131, 77)");
    const cancelled = page.locator('.history-card[data-fulfillment="cancelled"]');
    assert.match(await cancelled.locator(".history-card__states").innerText(), /Отменён/);
    assert.notEqual(await cancelled.locator(".history-status").first().evaluate((node) => getComputedStyle(node).color),
      await received.locator(".history-status").first().evaluate((node) => getComputedStyle(node).color));
    assert.match(await page.locator('.history-card[data-fulfillment="in_transit"]').first().locator(".history-card__states").innerText(), /В пути/);
    const supplierOrder = page.locator('.history-card[data-fulfillment="in_transit"]').filter({
      has: page.locator("h3", { hasText: /^Заказ № SUPPLIER$/ }),
    });
    assert.match(await supplierOrder.locator(".history-card__states").innerText(), /В пути/);
    assert.equal(await supplierOrder.locator(".history-item-status .history-status--in_transit").count(), 1);
    assert.equal(await supplierOrder.locator(".history-status-detail").innerText(),
      "Заказ передан поставщику. Поставщик подтвердил наличие товара.");
    assert.doesNotMatch(await supplierOrder.innerText(), /Статус не уточнён|В обработке|Получен/);
    const initial = page.locator(".history-card").filter({ has: page.locator("h3", { hasText: /^Заказ № INITIAL$/ }) });
    assert.equal(await initial.getAttribute("data-fulfillment"), "in_transit");
    assert.match(await initial.locator(".history-card__states").innerText(), /В пути/);
    assert.equal(await initial.locator(".history-item-status .history-status--in_transit").count(), 1);
    assert.equal(await initial.locator(".history-status-detail").innerText(), "Принят в работу");
    assert.doesNotMatch(await initial.innerText(), /Статус не уточнён|В обработке|Получен/);
    const inbound = page.locator(".history-card").filter({ has: page.locator("h3", { hasText: /^Заказ № INBOUND$/ }) });
    assert.equal(await inbound.getAttribute("data-fulfillment"), "in_transit");
    assert.match(await inbound.locator(".history-card__states").innerText(), /В пути/);
    assert.match(await page.locator('.history-card[data-fulfillment="ready"] .history-card__states').innerText(), /На складе/);
    assert.match(await page.locator('.history-card[data-fulfillment="partial"] .history-card__states').innerText(), /Частичная поставка/);
    const ready = page.locator('.history-card[data-fulfillment="ready"]');
    const moving = page.locator('.history-card[data-fulfillment="in_transit"]').first();
    assert.equal(await ready.evaluate((node) => getComputedStyle(node).borderLeftColor), "rgb(40, 116, 187)");
    assert.equal(await ready.locator(".history-status").first().evaluate((node) => getComputedStyle(node).color), "rgb(27, 95, 159)");
    assert.equal(await ready.evaluate((node) => getComputedStyle(node).borderLeftColor),
      await moving.evaluate((node) => getComputedStyle(node).borderLeftColor));
    assert.equal(await ready.locator(".history-status").first().evaluate((node) => getComputedStyle(node).color),
      await moving.locator(".history-status").first().evaluate((node) => getComputedStyle(node).color));
    assert.match(await page.locator('.history-card[data-fulfillment="unknown"] .history-card__states').innerText(), /Статус не уточнён/);
    const mixed = page.locator('.history-card[data-fulfillment="mixed"] .history-card__states');
    assert.equal(await mixed.locator(".history-status").count(), 2);
    assert.match(await mixed.innerText(), /Получен · 1/);
    assert.match(await mixed.innerText(), /В пути · 1/);
    assert.equal(historyRequests.length, 1);
    assert.equal(new URL(historyRequests[0]).search, "");
    for (const supplier of ["armtek", "forum-auto", "rossko"]) {
      await page.locator(`#history-tab-${supplier}`).click();
      await page.waitForFunction((supplier) => document.querySelector(".history-card h3")?.textContent === `Заказ № ${supplier}`, supplier);
      assert.match(await page.locator(".history-card__states").innerText(), /В пути/);
      assert.match(await page.locator(".history-item-status").innerText(), /В пути/);
    }
    await page.locator("#history-tab-part-kom").click();
    await page.locator('.history-card[data-fulfillment="mixed"]').waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator("#history-modal").evaluate((node) => node.scrollWidth <= node.clientWidth), true);
  }, { fixedTime: "2026-10-15T12:00:00Z", partKomOrderHistory: async () => history, supplierOrderHistory: async (query) => ({ orders: [{ number: query.supplier,
    date: "2026-10-15", items: [{ article: "A1", brand: "TEST", title: "Тестовая деталь", quantity: 1, price: 100,
      status: "Отгружено", fulfillment: "in_transit", expectedDate: null, guaranteedDate: null, warehouse: null }] }], limited: false }) });
});

test("PartKOM settled partial cancellations split into cancelled and received rows with terminal filters and no delivery warning", async () => {
  const cases = [[10, 4, 6], [4, 2, 2], [20, 17, 3]];
  const history = parsePartKomOrderHistory([...cases, [10, 3, 6]].map(([quantity, releaseCount, refusalCount], index) => ({
    orderNumber: `CANCELLATION-FIXTURE-${index + 1}`, detailNum: `A${index + 1}`, maker: "TEST", description: "Тестовая деталь",
    quantity, releaseCount, refusalCount, price: 100, orderDate: "2026-10-16 12:30:00",
    expectedDate: "2026-10-17 09:00:00", guaranteedDate: "2026-10-17 12:00:00",
    stateTxt: "Заказ передан в службу доставки. Сопроводительные документы подготовлены.",
  })));
  await withCartPage(async (page) => {
    await page.locator("#history-toggle").click();
    await page.waitForFunction(() => document.querySelectorAll('.history-card[data-fulfillment="partially_cancelled"]').length === 3);
    const settled = page.locator('.history-card[data-fulfillment="partially_cancelled"]');
    for (const [index, [quantity, released, refused]] of cases.entries()) {
      const card = settled.nth(index);
      assert.equal(await card.locator(".history-status--partially_cancelled").count(), 1);
      assert.match(await card.locator(".history-card__states").innerText(), /Частично отменён/);
      assert.equal(await card.locator("tbody tr").count(), 2);
      for (const [rowIndex, [state, label, count]] of [["cancelled", "Отменено", refused], ["delivered", "Получено", released]].entries()) {
        const row = card.locator("tbody tr").nth(rowIndex);
        assert.equal(await row.locator(`.history-status--${state}`).count(), 1);
        assert.equal(await row.locator(".history-status-detail").innerText(), `${label} ${count} шт.`);
        assert.equal(await row.locator("td").nth(3).locator("span").innerText(), `${count} шт.`);
        assert.equal(await row.locator("td").nth(4).innerText(), new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" }).format(100 * count));
        assert.equal(await row.locator("td").first().locator("strong").innerText(), `TEST A${index + 1}`);
      }
      assert.equal(await card.locator(".history-card__quantity strong").innerText(), `1 / ${quantity}`);
      assert.equal(await card.locator(".history-card__total").innerText(), new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" }).format(100 * quantity));
      assert.equal(await card.locator(".delivery-date--warning").count(), 0);
      assert.equal(await card.evaluate((node) => getComputedStyle(node).borderLeftColor), "rgb(184, 60, 60)");
      assert.doesNotMatch(await card.innerText(), /Частичная поставка|передан в службу доставки/);
    }
    assert.equal(await page.locator('.history-card[data-fulfillment="partial"]').count(), 1);
    for (const status of ["cancelled", "delivered"]) {
      await page.locator(`#history-status-${status}`).click();
      assert.equal(await page.locator(".history-card").count(), 3);
      assert.equal(await settled.count(), 3);
    }
    await page.locator("#history-status-partial").click();
    assert.equal(await page.locator(".history-card").count(), 1);
    assert.equal(await settled.count(), 0);
    await page.locator("#history-status-today").click();
    assert.equal(await page.locator(".history-card").count(), 1);
    assert.equal(await settled.count(), 0);
    await page.locator("#history-status-active").click();
    assert.equal(await page.locator(".history-card").count(), 0);
    await page.locator("#history-tab-all").click();
    await page.waitForFunction(() => !document.querySelector(".history-loading") && document.querySelectorAll(".history-card").length === 4);
    await page.locator("#history-status-cancelled").click();
    assert.equal(await settled.count(), 3);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator("#history-modal").evaluate((node) => node.scrollWidth <= node.clientWidth), true);
  }, { fixedTime: "2026-10-17T12:00:00Z", partKomOrderHistory: async () => history });
});

test("Armtek actual issue overrides stale status and splits settled cancellation without duplicating totals", async () => {
  const base = { PIN: "A1", BRAND: "TEST", NAME: "Тестовая деталь", POSNR: "10", ORDER_DATE: "20261016120000",
    KWMENG: "1", ZZKWMENG: "1", Issued: "1", REJECTED: "0", REJ_MENGE: "0", PRICE: "100.50", CURRENCY: "RUB",
    STATUS: "позиция частично поставлена", DLVRD: "20261017090000", WRNTD: "20261017120000" };
  const history = parseArmtekOrderHistory({ DATA: [
    { ...base, ORDER: "ISSUED" },
    { ...base, ORDER: "SPLIT", ZZKWMENG: "10", KWMENG: "4", Issued: "4", REJECTED: "6" },
    { ...base, ORDER: "PENDING", ZZKWMENG: "10", KWMENG: "4", Issued: "3", REJECTED: "6" },
    { ...base, ORDER: "SHIPPED", Issued: "0", KWMENG_R: "1", STATUS: "", ORDER_STATUS: "Закрыт" },
  ] });
  history.orders.find(({ number }) => number === "SPLIT").items[0].returnDays = 14;
  const money = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" });
  await withCartPage(async (page) => {
    await page.locator("#history-toggle").click();
    await page.locator("#history-tab-armtek").click();
    await page.waitForFunction(() => document.querySelectorAll(".history-card").length === 4);
    const card = (number) => page.locator(".history-card").filter({ has: page.locator("h3", { hasText: `Заказ № ${number}` }) });
    const issued = card("ISSUED");
    assert.equal(await issued.getAttribute("data-fulfillment"), "delivered");
    assert.equal(await issued.locator("tbody tr").count(), 1);
    assert.match(await issued.locator(".history-item-status").innerText(), /Получен.*Получено 1 из 1 шт\./s);
    assert.doesNotMatch(await issued.innerText(), /Частичная поставка|частично поставлена/);
    const split = card("SPLIT");
    assert.equal(await split.getAttribute("data-fulfillment"), "partially_cancelled");
    assert.equal(await split.locator("tbody tr").count(), 2);
    assert.equal(await split.locator(".history-card__quantity strong").innerText(), "1 / 10");
    assert.equal(await split.locator(".history-card__total").innerText(), money.format(1005));
    for (const [index, [state, label, quantity]] of [["cancelled", "Отменено", 6], ["delivered", "Получено", 4]].entries()) {
      const row = split.locator("tbody tr").nth(index);
      assert.equal(await row.locator(`.history-status--${state}`).count(), 1);
      assert.equal(await row.locator(".history-status-detail").innerText(), `${label} ${quantity} шт.`);
      assert.equal(await row.locator("td").nth(3).locator("span").innerText(), `${quantity} шт.`);
      assert.equal(await row.locator("td").nth(4).innerText(), money.format(100.5 * quantity));
      assert.match(await row.locator(".order-return-terms").innerText(), /Возврат: 14 дн\./);
    }
    assert.equal(await split.locator(".history-status--cancelled").evaluate((node) => getComputedStyle(node).color), "rgb(161, 46, 53)");
    assert.equal(await split.locator(".history-status--delivered").evaluate((node) => getComputedStyle(node).color),
      await issued.locator(".history-item-status .history-status--delivered").evaluate((node) => getComputedStyle(node).color));
    assert.equal(await card("PENDING").getAttribute("data-fulfillment"), "partial");
    assert.equal(await card("PENDING").locator("tbody tr").count(), 1);
    assert.equal(await card("SHIPPED").getAttribute("data-fulfillment"), "in_transit");
    for (const [status, expected] of [["delivered", 2], ["cancelled", 1], ["partial", 1], ["today", 2], ["active", 1]]) {
      await page.locator(`#history-status-${status}`).click();
      assert.equal(await page.locator(".history-card").count(), expected);
    }
    await page.locator("#history-status-all").click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator("#history-modal").evaluate((node) => node.scrollWidth <= node.clientWidth), true);
  }, { fixedTime: "2026-10-17T12:00:00Z", supplierOrderHistory: async () => history });
});

test("history rejects malformed receipt and cancellation quantities instead of inventing split rows", async () => {
  let quantities = null;
  await withCartPage(async (page) => {
    await page.locator("#history-toggle").click();
    await page.waitForFunction(() => document.querySelector("#history-results").textContent.includes("PartKOM вернул некорректную историю"));
    for (const invalid of [[], {}, { delivered: "1", cancelled: 1 }, { delivered: 1, cancelled: 0 },
      { delivered: -1, cancelled: 3 }, { delivered: 1, cancelled: 2 }, { delivered: Infinity, cancelled: 1 }]) {
      quantities = invalid;
      const response = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/order-history/part-kom");
      await page.locator("#history-reload").click();
      await response;
      await page.waitForFunction(() => document.querySelector("#history-results").textContent.includes("PartKOM вернул некорректную историю"));
      assert.equal(await page.locator(".history-card").count(), 0);
    }
  }, { partKomOrderHistory: async () => ({ orders: [{ number: "INVALID-SPLIT", date: "2026-10-16", items: [{ article: "A1",
    brand: "TEST", title: "Тестовая деталь", quantity: 2, price: 100, status: null, fulfillment: "partially_cancelled",
    fulfillmentQuantities: quantities, expectedDate: null, guaranteedDate: null, warehouse: null }] }], limited: false }) });
});

test("new cancellations share one history form across suppliers and stay unread until confirmed, including across browsers", async () => {
  let refused = 2;
  const partKomHistory = () => parsePartKomOrderHistory([{ orderNumber: "NEW-PARTKOM", orderDate: "2026-10-16 12:00:00",
    detailNum: "A1", maker: "TEST", description: "Тестовая частичная отмена", quantity: 10, price: 100, releaseCount: 3, refusalCount: refused }]);
  const supplierHistory = (supplier) => ({ limited: false, orders: [{ number: `NEW-${supplier}`, date: "2026-10-16", items: [{
    article: "B1", brand: "TEST", title: "Тестовая отмена <img src=x onerror=window.noticeXss=1>", quantity: 10, price: 100,
    status: "Отмена", fulfillment: supplier === "armtek" ? "partially_cancelled" : "cancelled",
    ...(supplier === "armtek" ? { fulfillmentQuantities: { delivered: 4, cancelled: 6 } } : {}),
    expectedDate: null, guaranteedDate: null, warehouse: null }, ...(supplier === "rossko" ? [{ article: "RETURNED", brand: "TEST",
      title: "Возврат", quantity: 1, price: 100, status: null, fulfillment: "returned", expectedDate: null, guaranteedDate: null, warehouse: null }] : [])] }] });
  await withCartPage(async (page, { origin }) => {
    const open = async () => {
      await page.locator("#history-toggle").click();
      await page.waitForFunction(() => document.querySelector("#history-cancellation-title")?.textContent === "Новые отмены: 4"
        && !document.querySelector("#history-cancellation-description").textContent.includes("Проверяем"));
    };
    await open();
    assert.equal(await page.locator(".history-card").count(), 1);
    await page.locator("#history-status-partial").click();
    await page.locator("#history-cancellation-view").click();
    assert.equal(await page.locator("dialog[open]").count(), 1);
    assert.equal(await page.locator("#history-tabs").isVisible(), false);
    assert.equal(await page.locator(".history-card").count(), 4);
    assert.deepEqual((await page.locator(".history-card__identity > small:first-child").allTextContents()).sort(), ["Armtek", "Forum Auto", "PartKOM", "Rossko"]);
    assert.equal(await page.locator(".history-card tbody tr").count(), 4);
    assert.match(await page.locator(".history-cancellation-time").first().innerText(), /^Обнаружено: \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}$/);
    const partKom = page.locator(".history-card").filter({ has: page.locator("h3", { hasText: "Заказ № NEW-PARTKOM" }) });
    assert.equal(await partKom.locator(".history-status-detail").innerText(), "Отменено 2 шт.");
    assert.equal(await partKom.locator(".history-card__quantity > span").innerText(), "Отменено позиций / штук");
    assert.equal(await partKom.locator(".history-card__total").innerText(), new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" }).format(200));
    assert.equal(await page.locator(".history-card img").count(), 0);
    assert.equal(await page.evaluate(() => window.noticeXss), undefined);
    assert.doesNotMatch(await page.locator("#history-results").innerText(), /RETURNED|Получено|Получен|Частичная поставка/);
    if (process.env.TEST_CAPTURE_DIR) await page.locator("#history-modal").screenshot({ path: join(process.env.TEST_CAPTURE_DIR, "new-cancellations-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator("#history-modal").evaluate((node) => node.scrollWidth <= node.clientWidth), true);
    if (process.env.TEST_CAPTURE_DIR) await page.locator("#history-modal").screenshot({ path: join(process.env.TEST_CAPTURE_DIR, "new-cancellations-mobile.png") });
    await page.locator("#history-cancellation-back").click();
    assert.equal(await page.locator("#history-status-partial").getAttribute("aria-selected"), "true");
    await page.locator("#history-close").click();
    await page.reload();
    await open();
    await page.locator("#history-cancellation-view").click();
    await page.keyboard.press("Escape");
    await open();
    await page.locator("#history-cancellation-view").click();
    await page.locator("#history-cancellation-done").click();
    await page.waitForFunction(() => document.querySelector("#history-title").textContent === "История заказов"
      && document.querySelector("#history-cancellation-notice").hidden);
    const other = await page.context().browser().newContext();
    try {
      const second = await other.newPage();
      await second.clock.setFixedTime(new Date("2026-10-17T12:00:00Z"));
      await second.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      await second.goto(origin);
      await second.locator("#history-toggle").click();
      await second.waitForFunction(() => document.querySelector("#history-cancellation-notice").hidden);
    } finally { await other.close(); }
    refused = 3;
    await page.locator("#history-reload").click();
    await page.waitForFunction(() => document.querySelector("#history-cancellation-title").textContent === "Новые отмены: 1"
      && !document.querySelector("#history-cancellation-description").textContent.includes("Проверяем"));
    await page.locator("#history-cancellation-view").click();
    assert.equal(await page.locator(".history-card").count(), 1);
    assert.equal(await page.locator(".history-status-detail").innerText(), "Отменено 3 шт.");
  }, { allSuppliers: true, fixedTime: "2026-10-17T12:00:00Z", partKomOrderHistory: async () => partKomHistory(),
    supplierOrderHistory: async ({ supplier }) => supplierHistory(supplier) });
});

test("acknowledging a cancellation view preserves a newer server revision discovered in another session", async () => {
  let refused = 2;
  await withCartPage(async (page, { origin }) => {
    await page.locator("#history-toggle").click();
    await page.waitForFunction(() => document.querySelector("#history-cancellation-title").textContent === "Новые отмены: 1"
      && !document.querySelector("#history-cancellation-description").textContent.includes("Проверяем"));
    await page.locator("#history-cancellation-view").click();
    assert.equal(await page.locator(".history-status-detail").innerText(), "Отменено 2 шт.");
    refused = 4;
    await page.request.get(`${origin}/api/order-history/part-kom`);
    await page.locator("#history-cancellation-done").click();
    await page.waitForFunction(() => document.querySelector("#history-title").textContent === "История заказов"
      && document.querySelector("#history-cancellation-title").textContent === "Новые отмены: 1");
    await page.locator("#history-cancellation-view").click();
    assert.equal(await page.locator(".history-status-detail").innerText(), "Отменено 4 шт.");
  }, { fixedTime: "2026-10-17T12:00:00Z", partKomOrderHistory: async () => parsePartKomOrderHistory([{ orderNumber: "RACE",
    orderDate: "2026-10-16", detailNum: "A1", quantity: 10, price: 100, refusalCount: refused, releaseCount: 0 }]) });
});

test("failed checks retain known cancellations and a failed acknowledgement remains visible without marking them read", async () => {
  let failSupplier = false;
  let failAcknowledgement = true;
  const history = { limited: false, orders: [{ number: "SAVED", date: "2026-10-16", items: [{ article: "A1", brand: "TEST",
    title: "Тестовая отмена", quantity: 1, price: 100, status: "Отменено", fulfillment: "cancelled",
    expectedDate: null, guaranteedDate: null, warehouse: null }] }] };
  await withCartPage(async (page) => {
    await page.locator("#history-toggle").click();
    await page.waitForFunction(() => document.querySelector("#history-cancellation-title").textContent === "Новые отмены: 1"
      && !document.querySelector("#history-cancellation-description").textContent.includes("Проверяем"));
    await page.locator("#history-close").click();
    failSupplier = true;
    await page.locator("#history-toggle").click();
    await page.waitForFunction(() => document.querySelector("#history-cancellation-description").textContent.includes("Не удалось проверить: Armtek"));
    await page.locator("#history-cancellation-view").click();
    assert.equal(await page.locator(".history-card").count(), 1);
    await page.route("**/api/order-cancellations/seen", (route) => failAcknowledgement
      ? route.fulfill({ status: 500, json: { message: "Не удалось сохранить просмотр отмен." } }) : route.continue());
    await page.locator("#history-cancellation-done").click();
    await page.waitForFunction(() => document.querySelector("#history-cancellation-description").textContent.includes("Не удалось сохранить просмотр отмен"));
    assert.equal(await page.locator("#history-title").innerText(), "Новые отмены заказов");
    assert.equal(await page.locator("#history-cancellation-done").isEnabled(), true);
    failSupplier = false;
    await page.locator("#history-cancellation-retry").click();
    await page.waitForFunction(() => !document.querySelector("#history-cancellation-description").textContent.includes("Не удалось проверить")
      && !document.querySelector("#history-cancellation-description").textContent.includes("Проверяем"));
    failAcknowledgement = false;
    await page.locator("#history-cancellation-done").click();
    await page.waitForFunction(() => document.querySelector("#history-title").textContent === "История заказов"
      && document.querySelector("#history-cancellation-notice").hidden);
  }, { fixedTime: "2026-10-17T12:00:00Z", supplierOrderHistory: async ({ supplier }) => {
    if (supplier !== "armtek") return { limited: false, orders: [] };
    if (failSupplier) throw new SupplierAuthError();
    return history;
  } });
});

test("malformed cancellation notices preserve known alerts and do not allow acknowledging unrelated items", async () => {
  let malformed = true;
  const order = { number: "VALID-CANCELLATION", date: "2026-10-16", items: [{ article: "A1", brand: "TEST", title: "Тестовая отмена",
    quantity: 1, price: 100, status: null, fulfillment: "cancelled", expectedDate: null, guaranteedDate: null, warehouse: null }] };
  await withCartPage(async (page) => {
    await page.locator("#history-toggle.has-cancellations").waitFor();
    await page.route("**/api/order-cancellations", (route) => malformed ? route.fulfill({ json: { total: 1, notices: [{
      id: "00000000-0000-0000-0000-000000000001", supplier: "part-kom", revision: 1, detectedAt: "2026-10-16T12:00:00Z",
      order: { ...order, items: [{ ...order.items[0], fulfillment: "delivered" }] },
    }] } }) : route.continue());
    await page.locator("#history-toggle").click();
    await page.waitForFunction(() => document.querySelector("#history-cancellation-description").textContent.includes("Не удалось загрузить уведомления")
      && !document.querySelector("#history-cancellation-description").textContent.includes("Проверяем"));
    assert.equal(await page.locator(".history-card h3").innerText(), "Заказ № VALID-CANCELLATION");
    assert.equal(await page.locator("#history-cancellation-view").isVisible(), true);
    assert.equal(await page.locator("#history-cancellation-done").isVisible(), false);
    await page.locator("#history-cancellation-view").click();
    assert.notEqual(await page.locator(".history-card").getAttribute("data-cancellation-id"), "00000000-0000-0000-0000-000000000001");
    assert.equal(await page.locator(".history-status--delivered").count(), 0);
    await page.locator("#history-cancellation-back").click();
    malformed = false;
    await page.locator("#history-cancellation-retry").click();
    await page.waitForFunction(() => document.querySelector("#history-cancellation-title").textContent === "Новые отмены: 1"
      && !document.querySelector("#history-cancellation-description").textContent.includes("Проверяем"));
    await page.locator("#history-cancellation-view").click();
    assert.equal(await page.locator(".history-status-detail").innerText(), "Отменено 1 шт.");
  }, { fixedTime: "2026-10-17T12:00:00Z", partKomOrderHistory: async () => ({ orders: [order], limited: false }) });
});

test("history button shows a red circular indicator before opening and clears it only after cancellations are acknowledged", async () => {
  const history = { limited: false, orders: [{ number: "INDICATOR", date: "2026-10-16", items: [{ article: "A1", brand: "TEST",
    title: "Тестовая отмена", quantity: 1, price: 100, status: null, fulfillment: "cancelled",
    expectedDate: null, guaranteedDate: null, warehouse: null }] }] };
  await withCartPage(async (page) => {
    const toggle = page.locator("#history-toggle");
    await page.locator("#history-toggle.has-cancellations").waitFor();
    assert.equal(await page.locator("#history-modal").count(), 0);
    assert.match(await toggle.getAttribute("title"), /новые отмены.*1/);
    assert.match(await toggle.getAttribute("aria-label"), /Новые отмены: 1/);
    await toggle.hover();
    assert.deepEqual(await toggle.evaluate((node) => {
      const style = getComputedStyle(node);
      return [style.borderColor, style.borderWidth, style.borderRadius];
    }), ["rgb(220, 38, 38)", "2px", "50%"]);
    const pulse = await toggle.evaluate((node) => {
      const animation = node.getAnimations().find((animation) => animation.animationName === "history-cancellation-pulse");
      if (!animation) return null;
      animation.pause();
      animation.currentTime = 0;
      const first = getComputedStyle(node).boxShadow;
      animation.currentTime = 1200;
      const second = getComputedStyle(node).boxShadow;
      animation.play();
      return { first, second, iterations: getComputedStyle(node).animationIterationCount };
    });
    assert.ok(pulse);
    assert.notEqual(pulse.first, pulse.second);
    assert.equal(pulse.iterations, "infinite");
    for (const viewport of [{ width: 1366, height: 850 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
      await page.setViewportSize(viewport);
      const clipping = await toggle.evaluate((node) => {
        const animation = node.getAnimations().find((item) => item.animationName === "history-cancellation-pulse");
        animation.pause(); animation.currentTime = 1350;
        const spread = Number(/0px 0px 0px ([\d.]+)px/.exec(getComputedStyle(node).boxShadow)?.[1]);
        const box = node.getBoundingClientRect();
        const clippedBy = [];
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent); const bounds = parent.getBoundingClientRect();
          if (["hidden", "clip", "auto", "scroll"].includes(style.overflowX)
            && (box.left - spread < bounds.left - .5 || box.right + spread > bounds.right + .5)) clippedBy.push(`${parent.className}: horizontal`);
          if (["hidden", "clip", "auto", "scroll"].includes(style.overflowY)
            && (box.top - spread < bounds.top - .5 || box.bottom + spread > bounds.bottom + .5)) clippedBy.push(`${parent.className}: vertical`);
        }
        animation.currentTime = 500;
        return { spread, clippedBy };
      });
      assert.equal(clipping.spread, 10);
      assert.deepEqual(clipping.clippedBy, [], `The entire pulse must fit at ${viewport.width}px`);
    }
    await page.setViewportSize({ width: 1366, height: 850 });
    const box = await toggle.boundingBox();
    assert.equal(box.width, 40);
    assert.equal(box.height, 40);
    if (process.env.TEST_CAPTURE_DIR) await page.screenshot({ path: join(process.env.TEST_CAPTURE_DIR, "history-cancellation-indicator.png"),
      clip: { x: Math.max(0, box.x - 12), y: Math.max(0, box.y - 12), width: 64, height: 64 } });
    await toggle.click();
    await page.locator("#history-close").click();
    assert.equal(await toggle.evaluate((node) => node.classList.contains("has-cancellations")), true);
    await toggle.click();
    await page.locator("#history-cancellation-view").click();
    await page.locator("#history-cancellation-done").click();
    await page.waitForFunction(() => !document.querySelector("#history-toggle").classList.contains("has-cancellations"));
    assert.equal(await toggle.getAttribute("title"), "История заказов");
    assert.equal(await toggle.getAttribute("aria-label"), "Открыть историю заказов");
    assert.equal(await toggle.evaluate((node) => getComputedStyle(node).borderWidth), "1px");
    assert.equal(await toggle.evaluate((node) => getComputedStyle(node).animationName), "none");
    await page.locator("#history-close").click();
    await page.reload();
    await page.locator('#armtek-auth-form[data-authorized="true"]').waitFor({ state: "attached" });
    assert.equal(await toggle.evaluate((node) => node.classList.contains("has-cancellations")), false);
  }, { fixedTime: "2026-10-17T12:00:00Z", partKomOrderHistory: async () => history });
});

test("history cancellation indicator stays red without pulsing when reduced motion is requested", async () => {
  await withCartPage(async (page) => {
    const toggle = page.locator("#history-toggle.has-cancellations");
    await toggle.waitFor();
    assert.deepEqual(await toggle.evaluate((node) => {
      const style = getComputedStyle(node);
      return [style.animationName, style.borderColor, style.borderWidth];
    }), ["none", "rgb(220, 38, 38)", "2px"]);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    assert.equal(await toggle.evaluate((node) => getComputedStyle(node).animationName), "history-cancellation-pulse");
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await toggle.evaluate((node) => getComputedStyle(node).animationName), "none");
  }, { reducedMotion: "reduce", partKomOrderHistory: async () => ({ limited: false, orders: [{ number: "REDUCED-MOTION",
    date: "2026-10-16", items: [{ article: "A1", brand: "TEST", title: "Тестовая отмена", quantity: 1, price: 100,
      status: null, fulfillment: "cancelled", expectedDate: null, guaranteedDate: null, warehouse: null }] }] }) });
});

test("history indicator checks suppliers on returning to the page, throttles repeated focus and preserves alerts on errors", async () => {
  let refused = 0;
  let calls = 0;
  let failedInbox = false;
  await withCartPage(async (page, { origin }) => {
    const toggle = page.locator("#history-toggle");
    assert.equal(calls, 1);
    assert.equal(await toggle.evaluate((node) => node.classList.contains("has-cancellations")), false);
    refused = 2;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    assert.equal(calls, 1);
    await page.clock.setFixedTime(new Date("2026-10-17T12:01:01Z"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.locator("#history-toggle.has-cancellations").waitFor();
    assert.equal(calls, 2);
    assert.equal(await page.locator("#history-modal").count(), 0);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    assert.equal(calls, 2);
    await page.route("**/api/order-cancellations", (route) => failedInbox ? route.fulfill({ status: 500, json: {} }) : route.continue());
    failedInbox = true;
    await page.clock.setFixedTime(new Date("2026-10-17T12:02:02Z"));
    const failed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/order-cancellations" && response.status() === 500);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await failed;
    assert.equal(await toggle.evaluate((node) => node.classList.contains("has-cancellations")), true);
    failedInbox = false;
    const pageOfNotices = await (await page.request.get(`${origin}/api/order-cancellations`)).json();
    await page.request.post(`${origin}/api/order-cancellations/seen`, { data: { notices: pageOfNotices.notices.map(({ id, revision }) => ({ id, revision })) } });
    await page.clock.setFixedTime(new Date("2026-10-17T12:03:03Z"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForFunction(() => !document.querySelector("#history-toggle").classList.contains("has-cancellations"));
  }, { fixedTime: "2026-10-17T12:00:00Z", partKomOrderHistory: async () => {
    calls++;
    return parsePartKomOrderHistory([{ orderNumber: "FOCUS", orderDate: "2026-10-16", detailNum: "A1", quantity: 10,
      price: 100, refusalCount: refused, releaseCount: 0, stateTxt: "В работе" }]);
  } });
});

test("history sorts every supplier newest first regardless of item status and aligns columns across different card contents", async () => {
  const order = (number, states, date = "2026-10-15 12:30:00", fields = {}) => ({ number, date,
    items: states.map((fulfillment) => ({ article: "A1", brand: "TEST", title: "Тестовая деталь", quantity: 2, price: 343,
      status: null, fulfillment, expectedDate: "2026-10-20", guaranteedDate: null, warehouse: null, ...fields })) });
  const history = { orders: [
    order("RECEIVED", ["delivered"]),
    order("CANCELLED-MIXED", ["delivered", "cancelled"]),
    order("PARTIAL-MIXED", ["cancelled", "partial"]),
    order("MOVING-MIXED", ["partial", "in_transit"], "2026-10-13 12:30:00"),
    order("READY", ["ready"], "2026-10-14 12:30:00"),
    order("PROCESSING-OLD", ["processing"], "2026-10-11 12:30:00"),
    order("PROCESSING-MIXED", ["cancelled", "processing"], "2026-10-12 12:30:00", {
      title: "Тестовая деталь с длинным описанием для проверки переноса строк в колонке запчасти".repeat(3),
      status: "Подробный статус поставщика с дополнительным пояснением", warehouse: "Тестовый склад выдачи",
      guaranteedDate: "2026-10-22", price: 123456.78,
    }),
    order("PROCESSING-NEW", ["processing"]),
    order("UNPRICED", ["in_transit"], null, { price: null }),
    order("RETURNED", ["returned"]), order("UNAVAILABLE", ["cancelled"], "2026-10-15 18:45:00"),
    order("UNKNOWN", ["processing", "unknown"], "2026-10-12 19:00:00"),
  ], limited: false };
  const expected = ["UNAVAILABLE", "RECEIVED", "CANCELLED-MIXED", "PARTIAL-MIXED", "PROCESSING-NEW", "RETURNED",
    "READY", "MOVING-MIXED", "UNKNOWN", "PROCESSING-MIXED", "PROCESSING-OLD", "UNPRICED"].map((number) => `Заказ № ${number}`);
  const alignedColumns = async (page) => {
    const cards = await page.locator(".history-card").evaluateAll((nodes) => nodes.map((node) => {
      const rect = (element) => { const { x, width } = element.getBoundingClientRect(); return { x, width }; };
      return { columns: [...node.querySelectorAll("thead th")].map(rect),
        cells: [...node.querySelectorAll("tbody tr")].map((row) => [...row.children].map(rect)),
        ordered: rect(node.querySelector(".history-card__ordered")), quantity: rect(node.querySelector(".history-card__quantity")),
        overflows: node.scrollWidth > node.clientWidth,
        tableOverflows: node.querySelector("table").scrollWidth > node.querySelector("table").clientWidth };
    }));
    for (const card of cards) {
      for (const [index, column] of card.columns.entries()) {
        assert.ok(Math.abs(column.x - cards[0].columns[index].x) < 1);
        assert.ok(Math.abs(column.width - cards[0].columns[index].width) < 1);
        for (const cells of card.cells) assert.ok(Math.abs(cells[index].x - column.x) < 1);
      }
      assert.ok(Math.abs(card.ordered.x - cards[0].ordered.x) < 1);
      assert.ok(Math.abs(card.quantity.x - cards[0].quantity.x) < 1);
      assert.equal(card.overflows, false);
      assert.equal(card.tableOverflows, false);
    }
  };
  await withCartPage(async (page) => {
    await page.locator("#history-toggle").click();
    for (const supplier of ["part-kom", "armtek", "forum-auto", "rossko"]) {
      if (supplier !== "part-kom") await page.locator(`#history-tab-${supplier}`).click();
      await page.locator(".history-card").first().waitFor();
      assert.deepEqual(await page.locator(".history-card h3").allTextContents(), supplier === "armtek"
        ? expected.filter((heading) => heading !== "Заказ № UNPRICED") : expected);
      const mixed = page.locator(".history-card").filter({ has: page.locator("h3", { hasText: "CANCELLED-MIXED" }) });
      assert.match(await mixed.locator(".history-card__states").innerText(), /Отменён.*Получен/s);
      await alignedColumns(page);
      await page.locator("#history-status-cancelled").click();
      assert.deepEqual(await page.locator(".history-card h3").allTextContents(), ["Заказ № UNAVAILABLE", "Заказ № CANCELLED-MIXED", "Заказ № PARTIAL-MIXED", "Заказ № PROCESSING-MIXED"]);
      await page.locator("#history-status-all").click();
    }
    if (process.env.HISTORY_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.HISTORY_SCREENSHOT_DIR, "history-desktop.png") });
    await page.locator("#history-reload").click();
    await page.locator(".history-card").first().waitFor();
    assert.deepEqual(await page.locator(".history-card h3").allTextContents(), expected);
    for (const width of [800, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await alignedColumns(page);
      assert.equal(await page.locator("#history-modal").evaluate((node) => node.scrollWidth <= node.clientWidth), true);
      if (process.env.HISTORY_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.HISTORY_SCREENSHOT_DIR, `history-${width}.png`) });
    }
  }, { fixedTime: "2026-10-15T12:00:00Z", partKomOrderHistory: async () => history, supplierOrderHistory: async () => history });
});

test("Rossko completed order uses green received badges and handed-to-customer details, while mixed orders remain mixed", async () => {
  let reloaded = false;
  const part = (article, status) => `<part><partnumber>${article}</partnumber><brand>TEST</brand><name>Тестовая деталь</name>
    <count>1</count><price>100</price><status>${status}</status></part>`;
  await withCartPage(async (page) => {
    await page.locator("#history-toggle").click();
    await page.locator("#history-tab-rossko").click();
    const card = page.locator('.history-card[data-fulfillment="delivered"]');
    await card.waitFor();
    assert.match(await card.locator(".history-card__states").innerText(), /Получен/);
    assert.equal(await card.locator(".history-item-status .history-status--delivered").count(), 2);
    assert.deepEqual(await card.locator(".history-status-detail").allTextContents(), ["Передан покупателю", "Передан покупателю"]);
    assert.doesNotMatch(await card.innerText(), /В пути|Отгружено/);
    assert.equal(await card.evaluate((node) => getComputedStyle(node).borderLeftColor), "rgb(35, 131, 77)");
    reloaded = true;
    await page.locator("#history-reload").click();
    const mixed = page.locator('.history-card[data-fulfillment="mixed"]');
    await mixed.waitFor();
    assert.equal(await mixed.locator(".history-item-status .history-status--delivered").count(), 1);
    assert.equal(await mixed.locator(".history-item-status .history-status--processing").count(), 1);
    assert.match(await mixed.locator(".history-card__states").innerText(), /Получен · 1/);
    assert.match(await mixed.locator(".history-card__states").innerText(), /В обработке · 1/);
  }, { supplierOrderHistory: async () => parseRosskoOrderHistory(`<Envelope><Body><OrdersResult><success>true</success><OrdersList>
    <Order><id>771</id><created_date>15.10.2026 12:30:00</created_date><parts>
    ${part("A1", reloaded ? 1 : 2)}${part("B1", 2)}</parts></Order></OrdersList></OrdersResult></Body></Envelope>`) });
});

test("Rossko returned and unavailable positions use returned and cancelled tabs without an attention status", async () => {
  const part = (article, code) => `<part><partnumber>${article}</partnumber><brand>TEST</brand><name>Тестовая деталь</name>
    <price>100</price><count>1</count><status>${code}</status></part>`;
  const history = parseRosskoOrderHistory(`<Envelope><Body><OrdersResult><success>true</success><OrdersList>
    <Order><id>772</id><created_date>15.10.2026 12:30:00</created_date><delivery_date>18.10.2026</delivery_date><parts>
    ${part("A1", 31)}${part("B1", 31)}${part("C1", 36)}${part("D1", 7)}</parts></Order></OrdersList></OrdersResult></Body></Envelope>`);
  await withCartPage(async (page) => {
    await page.locator("#history-toggle").click();
    await page.locator("#history-tab-rossko").click();
    const card = page.locator(".history-card");
    await card.waitFor();
    assert.equal(await card.locator(".history-item-status .history-status--returned").count(), 3);
    assert.equal(await card.locator(".history-item-status .history-status--cancelled").count(), 1);
    assert.deepEqual(await card.locator(".history-status-detail").allTextContents(),
      ["Успешно возвращено", "Успешно возвращено", "Товар возвращён", "Нет в наличии"]);
    assert.doesNotMatch(await card.innerText(), /Требует внимания|Ожидаем товар на складе|Желаемая дата/);
    assert.match(await card.locator(".history-card__states").innerText(), /Отменён · 1/);
    assert.match(await card.locator(".history-card__states").innerText(), /Возвращён · 3/);
    for (const group of ["cancelled", "returned"]) {
      await page.locator(`#history-status-${group}`).click();
      assert.equal(await card.count(), 1);
      assert.equal(await card.locator("tbody tr").count(), 4);
    }
    await page.locator("#history-status-active").click();
    assert.equal(await card.count(), 0);
  }, { supplierOrderHistory: async () => history });
});

test("history cancels stale supplier results and shows safe errors and malformed payloads", async () => {
  await withCartPage(async (page) => {
    let releaseArmtek;
    const armtekGate = new Promise((resolve) => { releaseArmtek = resolve; });
    let armtekStarted;
    const started = new Promise((resolve) => { armtekStarted = resolve; });
    await page.route("**/api/order-history/armtek?*", async (route) => {
      armtekStarted();
      await armtekGate;
      await route.fulfill({ json: { orders: [], limited: false } });
    });
    await page.route("**/api/order-history/forum-auto", (route) => route.fulfill({ status: 401, json: { message: "Авторизация Forum Auto недоступна." } }));
    await page.route("**/api/order-history/rossko", (route) => route.fulfill({ json: { unexpected: true } }));
    await page.locator("#history-toggle").click();
    await page.locator("#history-tab-armtek").click();
    await started;
    await page.locator("#history-tab-forum-auto").click();
    await page.locator(".history-message.is-error").waitFor();
    releaseArmtek();
    assert.match(await page.locator("#history-results").innerText(), /Авторизация Forum Auto недоступна/);
    await page.locator("#history-tab-rossko").click();
    await page.waitForFunction(() => document.querySelector("#history-results").textContent.includes("Rossko вернул некорректную историю"));
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#history-modal[open]").count(), 0);
  });
});
