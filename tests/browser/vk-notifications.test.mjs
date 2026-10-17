import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { serveVkNotifications } from "../../src/backend/http/vk-notifications.ts";
import { EncryptedVkSettings } from "../../src/backend/notifications/encrypted-vk-settings.ts";
import { SqliteNotificationRepository } from "../../src/backend/notifications/sqlite-notification-repository.ts";
import { OrderNotificationService } from "../../src/backend/notifications/order-notification-service.ts";
import { VkClient } from "../../src/backend/notifications/vk-client.ts";

const fixtureToken = "vk1.a.fixture_not_a_real_key";
async function withSettings(check, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "aggregator-vk-browser-"));
  let server; let browser; let service;
  try {
    const settings = new EncryptedVkSettings(join(directory, "vk.enc.json"), options.noEncryption ? null : Buffer.alloc(32, 19));
    const repository = new SqliteNotificationRepository(join(directory, "orders.sqlite"));
    const sends = [];
    const client = new VkClient(async (url) => {
      let value;
      if (url.endsWith("groups.getTokenPermissions")) value = { mask: 4096, permissions: [] };
      else if (url.endsWith("groups.getById")) value = { groups: [{ id: 77, name: '<img src=x onerror="window.vkXss=1">' }] };
      else if (url.endsWith("messages.getConversations")) value = { count: options.multiple ? 2 : 1,
        items: Array.from({ length: options.multiple ? 2 : 1 }, (_, index) => ({ conversation: {
          peer: { id: 2000000001 + index, type: "chat" }, chat_settings: { state: "in", title: index ? "Другой чат" : "Рабочая беседа" }, can_write: { allowed: true },
        } })) };
      else { sends.push(url); throw new Error("No notification may be sent during connection setup"); }
      return new Response(JSON.stringify({ response: value }), { headers: { "Content-Type": "application/json" } });
    });
    service = new OrderNotificationService(settings, repository, client, { available: () => false,
      load: async () => { throw new Error("Supplier API must not be called by this test"); }, observe: () => {} });
    const html = await readFile("src/frontend/index.html", "utf8");
    const markup = /<details class="vk-notifications-settings"[\s\S]*?<\/details>/.exec(html)?.[0];
    assert.ok(markup);
    server = createServer(async (request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      if (await serveVkNotifications(request, response, url, service)) return;
      if (url.pathname === "/") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"></head><body><main style="width:420px;padding:20px">${markup}</main><script type="module" src="/vk-notifications-settings.js"></script></body></html>`);
      } else if (["/styles.css", "/vk-notifications-settings.js"].includes(url.pathname)) {
        response.setHeader("Content-Type", url.pathname.endsWith(".js") ? "application/javascript" : "text/css");
        response.end(await readFile(join("src/frontend", url.pathname.slice(1))));
      } else { response.statusCode = 404; response.end(); }
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_BROWSER_EXECUTABLE_PATH });
    const page = await browser.newPage({ viewport: { width: 800, height: 1000 } });
    const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin); await page.waitForLoadState("networkidle");
    await page.locator("#vk-notifications-settings summary").click();
    await page.waitForFunction(() => document.querySelector("#vk-notifications-connection").textContent.length > 0);
    await check(page, { sends, directory, settings, service });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server?.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await service?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("VK UI saves only a token, renders supplier text safely, remains paused and disconnects", async () => {
  await withSettings(async (page, { sends, settings }) => {
    await page.locator("#vk-notifications-token").fill(fixtureToken);
    await page.getByRole("button", { name: "Сохранить ключ" }).click();
    await page.waitForFunction(() => document.querySelector("#vk-notifications-connection").textContent.includes("Сообщество:"));
    assert.equal(await page.locator("#vk-notifications-token").inputValue(), "");
    assert.equal(await page.locator("#vk-notifications-enabled").isChecked(), false);
    assert.equal(await page.locator("#vk-notifications-enabled").isEnabled(), true);
    assert.equal(await page.locator("#vk-notifications-chat-label").isVisible(), false);
    assert.match(await page.locator("#vk-notifications-connection").textContent(), /Беседа: Рабочая беседа/);
    assert.equal(await page.evaluate(() => window.vkXss), undefined);
    assert.equal(await page.evaluate((key) => JSON.stringify(localStorage).includes(key), fixtureToken), false);
    assert.equal(sends.length, 0);
    await page.locator("#vk-notifications-enabled").check();
    await page.waitForFunction(() => document.querySelector("#vk-notifications-status").textContent.includes("Уведомления включены"));
    assert.equal(settings.get().enabled, true);
    await page.getByRole("button", { name: "Отключить ВК" }).click();
    await page.waitForFunction(() => document.querySelector("#vk-notifications-connection").textContent === "ВК пока не подключён.");
    assert.equal(settings.get(), null); assert.equal(sends.length, 0);
  });
});

test("VK UI requires an explicit recipient choice for multiple chats", async () => {
  await withSettings(async (page, { sends, settings }) => {
    await page.locator("#vk-notifications-token").fill(fixtureToken);
    await page.getByRole("button", { name: "Сохранить ключ" }).click();
    await page.locator("#vk-notifications-chat-label").waitFor({ state: "visible" });
    assert.equal(await page.locator("#vk-notifications-enabled").isDisabled(), true);
    assert.equal(settings.get().peerId, null);
    await page.locator("#vk-notifications-chat").selectOption("2000000002");
    await page.waitForFunction(() => !document.querySelector("#vk-notifications-enabled").disabled);
    assert.equal(settings.get().peerId, 2000000002);
    assert.equal(settings.get().enabled, false); assert.equal(sends.length, 0);
  }, { multiple: true });
});

test("VK UI prevents saving an unencrypted token when the server master key is missing", async () => {
  await withSettings(async (page) => {
    assert.equal(await page.locator("#vk-notifications-token").isDisabled(), true);
    assert.match(await page.locator("#vk-notifications-connection").textContent(), /шифрование/);
  }, { noEncryption: true });
});
