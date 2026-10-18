import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { chromium } from "playwright";
import { EncryptedVkSettings } from "../../src/backend/notifications/encrypted-vk-settings.ts";
import { SqliteNotificationRepository } from "../../src/backend/notifications/sqlite-notification-repository.ts";
import { OrderNotificationService } from "../../src/backend/notifications/order-notification-service.ts";
import { VkClient } from "../../src/backend/notifications/vk-client.ts";
import { serveOrderNotifications } from "../../src/backend/http/order-notifications.ts";

// Only fictional supplier data and a local server are used in these browser scenarios.
const now = Date.parse("2026-10-18T12:00:00Z");
const item = (index = 1) => ({ article: `A${index}`, brand: "TEST", title: index === 1 ? 'Фильтр <img src=x onerror="window.feedXss=1">' : `Тестовая деталь ${index}`,
  quantity: 10, price: 100, fulfillment: "processing" });
const history = (items = [item()], number = "ORDER-BASE") => ({ orders: [{ number, date: "2026-10-18", items }], limited: false });

async function withFeed(check) {
  const directory = await mkdtemp(join(tmpdir(), "aggregator-feed-browser-"));
  let browser; let server; let service;
  try {
    const repository = new SqliteNotificationRepository(join(directory, "orders.sqlite"));
    const suppliers = ["armtek", "part-kom", "forum-auto", "rossko"];
    repository.observeFeed(suppliers.map((supplier) => ({ supplier, histories: [history()] })), now);
    repository.observeFeed([
      { supplier: "armtek", histories: [history([{ ...item(), fulfillment: "partial", cancelledQuantity: 2, deliveredQuantity: 3 }])] },
      { supplier: "rossko", histories: [history([1, 2, 3, 4].map(item), "NEW-ORDER")] },
      { supplier: "forum-auto", histories: [{ orders: [], limited: false }] },
    ], now + 600_000);
    service = new OrderNotificationService(new EncryptedVkSettings(join(directory, "vk.enc.json"), Buffer.alloc(32, 8)), repository,
      new VkClient(async () => { throw new Error("VK must never be called by the website feed"); }), {
        available: () => false, load: async () => { throw new Error("Reading the feed must not query suppliers"); }, observe: () => {},
      }, () => now + 600_000);
    const addOrder = (number) => repository.observeFeed([{ supplier: "rossko", histories: [history([item(2)], number)] }], now + 1_200_000);
    let mode = "ok"; let onRead = null;
    const source = await readFile("src/frontend/index.html", "utf8");
    const nav = /<nav class="search-tabs[^>]*id="search-tabs"[\s\S]*?<\/nav>/.exec(source)?.[0]; assert.ok(nav);
    const files = new Map([["/styles.css", "text/css"], ["/order-notifications.css", "text/css"],
      ["/order-notifications-ui.js", "application/javascript"], ["/notification-bell.png", "image/png"]]);
    server = createServer(async (request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname.startsWith("/api/notifications/orders") && mode !== "ok"
        && (!mode.startsWith("ack-") || url.pathname.endsWith("/seen"))) {
        response.writeHead(mode.endsWith("offline") ? 503 : 200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ entries: [{ kind: "<script>" }], unreadCount: 0 })); return;
      }
      if (url.pathname.endsWith("/seen")) { onRead?.(); onRead = null; }
      if (await serveOrderNotifications(request, response, url, service)) return;
      if (url.pathname === "/") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/order-notifications.css"></head><body><main style="margin:16px">${nav}</main><script type="module" src="/order-notifications-ui.js"></script></body></html>`);
      } else if (files.has(url.pathname)) {
        response.setHeader("Content-Type", files.get(url.pathname)); response.end(await readFile(join("src/frontend", url.pathname.slice(1))));
      } else { response.statusCode = 404; response.end(); }
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_BROWSER_EXECUTABLE_PATH });
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    await page.clock.install({ time: new Date(now) });
    const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin);
    await page.waitForFunction(() => document.querySelector("#order-notifications-count").textContent === "4");
    await check(page, { origin, browser, service, addOrder, setMode: (value) => { mode = value; }, onRead: (action) => { onRead = action; } });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server?.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await service?.close(); await rm(directory, { recursive: true, force: true });
  }
}

test("bell shows safe colored order cards, multiple products and fits mobile with automatic visible reads", async () => {
  await withFeed(async (page) => {
    const trigger = page.locator("#order-notifications-trigger");
    await trigger.click();
    const panel = page.locator("#order-notifications-panel");
    assert.equal(await panel.locator(".order-notification-card").count(), 4);
    for (const kind of ["new", "cancelled", "received", "missing"]) assert.equal(await panel.locator(`.order-notification-card--${kind}`).count(), 1);
    assert.equal(await panel.locator("header p").count(), 0);
    await page.waitForFunction(() => Number(document.querySelector("#order-notifications-count").textContent) < 4);
    const cancelled = panel.locator(".order-notification-card--cancelled");
    assert.match(await cancelled.textContent(), /2 шт\./); assert.match(await cancelled.textContent(), /200/);
    assert.match(await panel.locator(".order-notification-card--received").textContent(), /3 шт\./);
    assert.match(await panel.locator(".order-notification-card--missing").textContent(), /мог быть получен или отменён/);
    assert.equal(await panel.locator("img,script,svg").count(), 0); assert.equal(await page.evaluate(() => window.feedXss), undefined);
    const order = panel.locator(".order-notification-card--new");
    assert.equal(await order.locator(".order-notification-products li").count(), 3);
    await order.getByRole("button", { name: "Ещё товаров: 1" }).click();
    assert.equal(await order.locator(".order-notification-products li").count(), 4);
    if (process.env.TEST_CAPTURE_DIR) await page.screenshot({ path: join(process.env.TEST_CAPTURE_DIR, "order-notifications-desktop.png") });
    await page.setViewportSize({ width: 390, height: 850 });
    // Viewport resizing may complete before the resize listener repositions the panel.
    await page.waitForFunction(() => {
      const bounds = document.querySelector("#order-notifications-panel").getBoundingClientRect();
      return bounds.x >= 0 && bounds.right <= 390 && bounds.bottom <= 850;
    });
    const bounds = await panel.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 850);
    if (process.env.TEST_CAPTURE_DIR) await page.screenshot({ path: join(process.env.TEST_CAPTURE_DIR, "order-notifications-mobile.png") });
    await page.keyboard.press("Escape"); assert.equal(await panel.isVisible(), false);
    assert.equal(await trigger.evaluate((node) => node === document.activeElement), true);
  });
});

test("read all includes unloaded older events, preserves a new arrival and shares visible reads across browsers", async () => {
  await withFeed(async (page, { onRead, addOrder, browser, origin, service }) => {
    for (let index = 0; index < 35; index++) addOrder(`BULK-${index}`);
    await page.clock.runFor(30_001);
    await page.waitForFunction(() => document.querySelector("#order-notifications-count").textContent === "39");
    await page.setViewportSize({ width: 1366, height: 480 });
    await page.locator("#order-notifications-trigger").click();
    await page.waitForFunction(() => Number(document.querySelector("#order-notifications-count").textContent) < 39
      && !document.querySelector("#order-notifications-read").disabled);
    await page.route("**/api/notifications/orders/seen", async (route) => {
      if (route.request().postDataJSON().throughId !== undefined) await page.keyboard.press("Escape");
      await route.continue();
    });
    onRead(() => addOrder("DURING-READ"));
    await page.locator("#order-notifications-read").click();
    await page.waitForFunction(() => document.querySelector("#order-notifications-count").textContent === "1");
    assert.equal(await page.locator("#order-notifications-panel").isVisible(), false);
    assert.equal(service.orderFeed().unreadCount, 1);
    assert.equal(service.orderFeed().entries[0].number, "DURING-READ");
    const other = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    await other.goto(origin);
    await other.waitForFunction(() => document.querySelector("#order-notifications-count").textContent === "1");
    await other.locator("#order-notifications-trigger").click();
    await other.waitForFunction(() => document.querySelector("#order-notifications-count").hidden);
    assert.equal(service.orderFeed().unreadCount, 0);
    await page.clock.runFor(30_001);
    await page.waitForFunction(() => document.querySelector("#order-notifications-count").hidden);
    assert.equal(await page.locator(".order-notification-card").count(), 30, "reading keeps the loaded event history");
    await other.close();
  });
});

test("feed polling and pagination retain every event after a long absence and failures preserve known alerts", async () => {
  await withFeed(async (page, { addOrder, setMode, service }) => {
    for (let index = 0; index < 35; index++) addOrder(`LATER-${index}`);
    await page.clock.runFor(30_001);
    await page.waitForFunction(() => document.querySelector("#order-notifications-count").textContent === "39");
    await page.locator("#order-notifications-trigger").click();
    assert.equal(await page.locator(".order-notification-card").count(), 30);
    await page.locator("#order-notifications-more").click();
    await page.waitForFunction(() => document.querySelectorAll(".order-notification-card").length === 39);
    const ids = await page.locator(".order-notification-card").evaluateAll((cards) => cards.map((card) => card.dataset.notificationId));
    assert.equal(new Set(ids).size, 39);
    await page.waitForFunction(() => !document.querySelector("#order-notifications-read").disabled);
    const unread = service.orderFeed().unreadCount;
    for (const mode of ["offline", "malformed"]) {
      setMode(mode); await page.clock.runFor(30_001);
      await page.locator(".order-notifications-error").waitFor({ state: "visible" });
      assert.equal(await page.locator("#order-notifications-count").textContent(), String(unread));
      assert.equal(await page.locator(".order-notification-card").count(), 39);
    }
    setMode("ok"); await page.locator(".order-notifications-error button").click();
    await page.locator(".order-notifications-error").waitFor({ state: "hidden" });
  });
});

test("failed automatic acknowledgements preserve unread cards and can be retried without a request loop", async () => {
  await withFeed(async (page, { setMode, service }) => {
    const acknowledgements = [];
    page.on("request", (request) => { if (new URL(request.url()).pathname.endsWith("/seen")) acknowledgements.push(request.postDataJSON()); });
    setMode("ack-offline");
    await page.locator("#order-notifications-trigger").click();
    const error = page.locator(".order-notifications-error");
    await error.waitFor({ state: "visible" });
    assert.equal(service.orderFeed().unreadCount, 4);
    assert.equal(await page.locator(".order-notification-card.is-unread").count(), 4);
    const failed = acknowledgements.length;
    await page.clock.runFor(100);
    assert.equal(acknowledgements.length, failed);
    setMode("ack-malformed");
    await error.getByRole("button", { name: "Повторить" }).click();
    await page.waitForFunction(() => !document.querySelector("#order-notifications-read").disabled);
    assert.equal(service.orderFeed().unreadCount, 4);
    assert.equal(await page.locator(".order-notification-card.is-unread").count(), 4);
    setMode("ok");
    await error.getByRole("button", { name: "Повторить" }).click();
    await page.waitForFunction(() => Number(document.querySelector("#order-notifications-count").textContent) < 4);
    assert.equal(await error.isVisible(), false);
  });
});

test("only cards in view are read; hidden pages and closed panels preserve unseen cards and show a clear divider", async () => {
  await withFeed(async (page, { addOrder, service }) => {
    for (let index = 0; index < 35; index++) addOrder(`VISIBLE-${index}`);
    await page.clock.runFor(30_001);
    await page.waitForFunction(() => document.querySelector("#order-notifications-count").textContent === "39");
    const acknowledgements = [];
    page.on("request", (request) => { if (new URL(request.url()).pathname.endsWith("/seen")) acknowledgements.push(request.postDataJSON()); });
    await page.setViewportSize({ width: 1366, height: 480 });
    await page.locator("#order-notifications-trigger").click();
    const settled = () => page.waitForFunction(() => Number(document.querySelector("#order-notifications-count").textContent) < 39
      && !document.querySelector("#order-notifications-read").disabled);
    await settled();
    assert.ok(service.orderFeed().unreadCount > 30, "opening must not read offscreen or unloaded cards");
    assert.ok(acknowledgements.length > 0 && acknowledgements.every((payload) => Array.isArray(payload.ids) && payload.throughId === undefined));
    assert.equal(await page.locator(".order-notification-card").first().evaluate((card) => card.classList.contains("is-unread")), false);
    assert.equal(await page.locator(".order-notification-card").last().evaluate((card) => card.classList.contains("is-unread")), true);
    const divider = page.getByRole("separator", { name: "Непрочитанные", exact: true });
    assert.equal(await divider.count(), 1);
    assert.equal(await divider.evaluate((node) => getComputedStyle(node, "::before").borderTopWidth), "2px");
    const beforeScroll = service.orderFeed().unreadCount;
    const order = await page.locator(".order-notification-card").evaluateAll((cards) => cards.map((card) => card.dataset.notificationId));
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
      const scroll = document.querySelector(".order-notifications-scroll"); scroll.scrollTop = scroll.scrollHeight;
    });
    await page.clock.runFor(100);
    assert.equal(service.orderFeed().unreadCount, beforeScroll);
    await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event("visibilitychange")); });
    await page.waitForFunction((previous) => Number(document.querySelector("#order-notifications-count").textContent) < previous, beforeScroll);
    await settled();
    assert.equal(await page.locator(".order-notification-card").last().evaluate((card) => card.classList.contains("is-unread")), false);
    assert.deepEqual(await page.locator(".order-notification-card").evaluateAll((cards) => cards.map((card) => card.dataset.notificationId)), order);
    if (process.env.TEST_CAPTURE_DIR) await page.screenshot({ path: join(process.env.TEST_CAPTURE_DIR, "order-notifications-read-divider.png") });
    await page.keyboard.press("Escape");
    const beforeClosed = service.orderFeed().unreadCount;
    await page.clock.runFor(30_001);
    assert.equal(service.orderFeed().unreadCount, beforeClosed);
    assert.ok(beforeClosed > 0);
  });
});
