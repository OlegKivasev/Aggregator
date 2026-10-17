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
    let deliverPoll;
    const client = new VkClient(async (url, init) => {
      if (new URL(url).hostname === "lp.vk.com") return new Promise((resolve, reject) => {
        deliverPoll = (text) => resolve(new Response(JSON.stringify({ ts: "2", updates: [{ type: "message_new", group_id: 77,
          object: { message: { peer_id: 2000000003, from_id: 123, out: 0, text } } }] }), { headers: { "Content-Type": "application/json" } }));
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
      const denied = url.endsWith("groups.getLongPollSettings") ? options.pollSettingsDenied
        : url.endsWith("groups.getLongPollServer") ? options.pollServerDenied : undefined;
      if (denied !== undefined) return new Response(JSON.stringify({ error: { error_code: denied, error_msg: fixtureToken } }), { headers: { "Content-Type": "application/json" } });
      let value;
      if (url.endsWith("groups.getTokenPermissions")) value = { mask: 4096, permissions: [] };
      else if (url.endsWith("groups.getById")) value = { groups: [{ id: 77, name: '<img src=x onerror="window.vkXss=1">' }] };
      else if (url.endsWith("messages.getConversations")) value = { count: options.noChats ? 0 : options.multiple ? 2 : 1,
        items: Array.from({ length: options.noChats ? 0 : options.multiple ? 2 : 1 }, (_, index) => ({ conversation: {
          peer: { id: 2000000001 + index, type: "chat" }, chat_settings: { state: "in", title: index ? "Другой чат" : "Рабочая беседа" }, can_write: { allowed: true },
        } })) };
      else if (url.endsWith("groups.getLongPollSettings")) value = { is_enabled: !options.pollDisabled, api_version: "5.199", events: { message_new: 1 } };
      else if (url.endsWith("groups.getLongPollServer")) value = { server: "https://lp.vk.com/whp/77", key: "fixture_ephemeral_key", ts: "1" };
      else if (url.endsWith("messages.getConversationsById")) value = options.chatDetails ?? { items: [{ peer: { id: 2000000003, type: "chat" }, chat_settings: { state: "in", title: "Автосервис" } }] };
      else if (url.endsWith("messages.send")) {
        const params = new URLSearchParams(init.body); sends.push(params);
        if (options.denied) return new Response(JSON.stringify({ error: { error_code: 7, error_msg: fixtureToken } }), { headers: { "Content-Type": "application/json" } });
        value = [{ peer_id: Number(params.get("peer_ids")), message_id: 0, conversation_message_id: sends.length }];
      } else throw new Error("Unexpected fixture request");
      return new Response(JSON.stringify({ response: value }), { headers: { "Content-Type": "application/json" } });
    });
    service = new OrderNotificationService(settings, repository, client, { available: () => false,
      load: async () => { throw new Error("Supplier API must not be called by this test"); }, observe: () => {} },
    () => options.now ?? Date.parse("2026-10-17T12:00:00Z"));
    const html = await readFile("src/frontend/index.html", "utf8");
    const markup = /<details class="vk-notifications-settings[^"]*"[\s\S]*?<\/details>/.exec(html)?.[0];
    assert.ok(markup);
    const reference = options.reference ? /<article class="auth-card" data-supplier="armtek">[\s\S]*?<\/article>/.exec(html)?.[0] : "";
    server = createServer(async (request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      if (await serveVkNotifications(request, response, url, service)) return;
      if (url.pathname === "/") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><main style="width:min(100%,620px);padding:20px;background:#fff">${markup}${reference}</main><script type="module" src="/vk-notifications-settings.js"></script></body></html>`);
      } else if (["/styles.css", "/vk-notifications-settings.js"].includes(url.pathname)) {
        response.setHeader("Content-Type", url.pathname.endsWith(".js") ? "application/javascript" : "text/css");
        response.end(await readFile(join("src/frontend", url.pathname.slice(1))));
      } else { response.statusCode = 404; response.end(); }
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_BROWSER_EXECUTABLE_PATH });
    const page = await browser.newPage({ viewport: { width: 800, height: 1000 }, timezoneId: "UTC" });
    const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin); await page.waitForLoadState("networkidle");
    await page.locator("#vk-notifications-settings summary").click();
    await page.waitForFunction(() => document.querySelector("#vk-notifications-connection").textContent.length > 0);
    await check(page, { sends, directory, settings, service, deliver: (text) => { assert.ok(deliverPoll); deliverPoll(text); } });
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
    assert.equal(sends.length, 1);
    assert.match(sends[0].get("message"), /Агрегатор автозапчастей подключён/);
    assert.match(await page.locator("#vk-notifications-status").textContent(), /Тестовое сообщение отправлено[\s\S]*Уведомления о заказах выключены/);
    await page.getByRole("button", { name: "Обновить состояние" }).click();
    await page.waitForFunction(() => !document.querySelector("#vk-notifications-refresh").disabled);
    assert.equal(sends.length, 1);
    await page.locator("#vk-notifications-enabled").check();
    await page.waitForFunction(() => document.querySelector("#vk-notifications-status").textContent.includes("Уведомления включены"));
    assert.equal(settings.get().enabled, true);
    await page.getByRole("button", { name: "Отключить ВК" }).click();
    await page.waitForFunction(() => document.querySelector("#vk-notifications-connection").textContent === "ВК пока не подключён.");
    assert.equal(settings.get(), null); assert.equal(sends.length, 1);
  });
});

test("VK settings share supplier form styling and fit a narrow settings panel", async () => {
  await withSettings(async (page) => {
    const styles = await page.evaluate(() => {
      const values = (selector) => {
        const value = getComputedStyle(document.querySelector(selector));
        return { background: value.backgroundColor, border: value.borderColor, radius: value.borderRadius, font: value.fontFamily };
      };
      return { button: values("#vk-notifications-form .btn-primary"), referenceButton: values("#armtek-auth-form .btn-primary"),
        field: values("#vk-notifications-token"), referenceField: values("#armtek-login") };
    });
    assert.deepEqual(styles.button.background, styles.referenceButton.background);
    assert.deepEqual(styles.field, styles.referenceField);
    assert.equal(await page.locator("#vk-notifications-suppliers").isVisible(), false);
    await page.setViewportSize({ width: 320, height: 1100 });
    const layout = await page.evaluate(() => {
      const section = document.querySelector("#vk-notifications-settings");
      return { page: document.documentElement.scrollWidth, viewport: innerWidth, section: section.getBoundingClientRect().width, content: section.scrollWidth };
    });
    assert.ok(layout.page <= layout.viewport); assert.ok(layout.content <= layout.section);
    await page.locator("#vk-notifications-token").focus();
    assert.notEqual(await page.locator("#vk-notifications-token").evaluate((input) => getComputedStyle(input).boxShadow), "none");
  }, { reference: true });
});

test("VK UI requires an explicit recipient choice for multiple chats", async () => {
  await withSettings(async (page, { sends, settings }) => {
    await page.locator("#vk-notifications-token").fill(fixtureToken);
    await page.getByRole("button", { name: "Сохранить ключ" }).click();
    await page.locator("#vk-notifications-chat-label").waitFor({ state: "visible" });
    assert.equal(await page.locator("#vk-notifications-enabled").isDisabled(), true);
    assert.equal(settings.get().peerId, null);
    assert.equal(sends.length, 0);
    await page.locator("#vk-notifications-chat").selectOption("2000000002");
    await page.waitForFunction(() => !document.querySelector("#vk-notifications-enabled").disabled);
    assert.equal(settings.get().peerId, 2000000002);
    assert.equal(settings.get().enabled, false); assert.equal(sends.length, 1);
    assert.equal(sends[0].get("peer_ids"), "2000000002");
    assert.match(await page.locator("#vk-notifications-status").textContent(), /Тестовое сообщение отправлено/);
  }, { multiple: true });
});

test("VK UI prevents saving an unencrypted token when the server master key is missing", async () => {
  await withSettings(async (page) => {
    assert.equal(await page.locator("#vk-notifications-token").isDisabled(), true);
    assert.match(await page.locator("#vk-notifications-connection").textContent(), /шифрование/);
  }, { noEncryption: true });
});

test("VK UI binds an undiscoverable chat through a one-time message without entering another API key", async () => {
  await withSettings(async (page, { sends, deliver, settings }) => {
    await page.locator("#vk-notifications-token").fill(fixtureToken);
    await page.getByRole("button", { name: "Сохранить ключ" }).click();
    await page.waitForFunction(() => document.querySelector("#vk-notifications-connection").textContent.includes("Подключите нужную беседу по сообщению"));
    assert.equal(await page.locator("#vk-notifications-enabled").isEnabled(), false);
    assert.equal(await page.locator("#vk-notifications-chat-label").isVisible(), false);
    assert.equal(sends.length, 0);
    await page.locator("#vk-notifications-pair-start").click();
    await page.locator("#vk-notifications-pair-command-panel").waitFor({ state: "visible" });
    const command = await page.locator("#vk-notifications-pair-command").inputValue();
    assert.match(command, /^\/aggregator [a-f0-9]{32}$/);
    assert.equal(await page.locator("#vk-notifications-token").inputValue(), "");
    await page.setViewportSize({ width: 320, height: 1100 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { value: { writeText: async (value) => { window.vkCopiedCommand = value; } } }));
    await page.locator("#vk-notifications-pair-copy").click();
    await page.waitForFunction(() => document.querySelector("#vk-notifications-pair-status").textContent.includes("Команда скопирована"));
    assert.match(await page.locator("#vk-notifications-pair-status").textContent(), /[Сс]копир/);
    assert.equal(await page.evaluate(() => window.vkCopiedCommand), command);
    deliver(`[club77|Магазин] ${command}`);
    await page.waitForFunction(() => document.querySelector("#vk-notifications-connection").textContent.includes("Беседа: Автосервис"));
    assert.equal(settings.get().peerId, 2000000003); assert.equal(settings.get().enabled, false);
    assert.equal(sends.length, 1); assert.equal(sends[0].get("peer_ids"), "2000000003");
    assert.equal(await page.locator("#vk-notifications-pairing").isVisible(), false);
    assert.match(await page.locator("#vk-notifications-status").textContent(), /Тестовое сообщение отправлено/);
  }, { noChats: true });
});

test("VK UI explains the missing Long Poll setting and allows cancelling the command", async () => {
  await withSettings(async (page, { sends }) => {
    await page.locator("#vk-notifications-token").fill(fixtureToken);
    await page.getByRole("button", { name: "Сохранить ключ" }).click();
    await page.locator("#vk-notifications-pair-start").waitFor({ state: "visible" });
    await page.locator("#vk-notifications-pair-start").click();
    await page.waitForFunction(() => document.querySelector("#vk-notifications-status").textContent.includes("Long Poll API"));
    assert.equal(await page.locator("#vk-notifications-pair-command-panel").isVisible(), false);
    assert.equal(sends.length, 0);
  }, { noChats: true, pollDisabled: true });
  await withSettings(async (page, { service, sends }) => {
    await page.locator("#vk-notifications-token").fill(fixtureToken);
    await page.getByRole("button", { name: "Сохранить ключ" }).click();
    await page.locator("#vk-notifications-pair-start").waitFor({ state: "visible" });
    await page.locator("#vk-notifications-pair-start").click();
    await page.locator("#vk-notifications-pair-command-panel").waitFor({ state: "visible" });
    await page.locator("#vk-notifications-pair-cancel").click();
    await page.locator("#vk-notifications-pair-command-panel").waitFor({ state: "hidden" });
    assert.equal(service.state().pairing, null); assert.equal(service.state().peerId, null); assert.equal(sends.length, 0);
  }, { noChats: true });
});

test("VK UI reports a failed welcome without exposing the token or claiming successful delivery", async () => {
  await withSettings(async (page, { sends, settings }) => {
    await page.locator("#vk-notifications-token").fill(fixtureToken);
    await page.getByRole("button", { name: "Сохранить ключ" }).click();
    await page.waitForFunction(() => document.querySelector("#vk-notifications-status").textContent.includes("Тестовое сообщение не отправлено"));
    const message = await page.locator("#vk-notifications-status").textContent();
    assert.equal(message.includes(fixtureToken), false); assert.equal(message.includes("Тестовое сообщение отправлено"), false);
    assert.equal(await page.locator("#vk-notifications-status").getAttribute("data-error"), "true");
    assert.equal(settings.get().enabled, false); assert.equal(sends.length, 1);
    assert.equal(await page.locator("#vk-notifications-token").inputValue(), "");
  }, { denied: true });
});

test("VK UI can pair and verify a welcome when reading administrative Long Poll settings is denied", async () => {
  await withSettings(async (page, { sends, settings, deliver }) => {
    await page.locator("#vk-notifications-token").fill(fixtureToken);
    await page.getByRole("button", { name: "Сохранить ключ" }).click();
    await page.locator("#vk-notifications-pair-start").waitFor({ state: "visible" });
    await page.locator("#vk-notifications-pair-start").click();
    await page.locator("#vk-notifications-pair-command-panel").waitFor({ state: "visible" });
    assert.equal(sends.length, 0); assert.equal(settings.get().peerId, null);
    deliver(await page.locator("#vk-notifications-pair-command").inputValue());
    await page.waitForFunction(() => document.querySelector("#vk-notifications-status").textContent.includes("Тестовое сообщение отправлено"));
    assert.equal(settings.get().peerId, 2000000003); assert.equal(settings.get().enabled, false); assert.equal(sends.length, 1);
  }, { noChats: true, pollSettingsDenied: 15 });
});

test("VK UI identifies a denied Long Poll server without blaming chat permissions and allows retry", async () => {
  const options = { noChats: true, pollSettingsDenied: 7, pollServerDenied: 15 };
  await withSettings(async (page, { sends, settings }) => {
    await page.locator("#vk-notifications-token").fill(fixtureToken);
    await page.getByRole("button", { name: "Сохранить ключ" }).click();
    await page.locator("#vk-notifications-pair-start").waitFor({ state: "visible" });
    await page.locator("#vk-notifications-pair-start").click();
    await page.waitForFunction(() => document.querySelector("#vk-notifications-status").textContent.includes("groups.getLongPollServer, код 15"));
    const message = await page.locator("#vk-notifications-status").textContent();
    assert.equal(message.includes(fixtureToken), false); assert.equal(message.includes("отправлять сообщения в выбранную беседу"), false);
    assert.equal(await page.locator("#vk-notifications-pair-command-panel").isVisible(), false);
    assert.equal(await page.locator("#vk-notifications-status").getAttribute("data-error"), "true");
    assert.equal(settings.get().peerId, null); assert.equal(sends.length, 0);
    delete options.pollServerDenied;
    await page.locator("#vk-notifications-pair-start").click();
    await page.locator("#vk-notifications-pair-command-panel").waitFor({ state: "visible" });
    assert.equal(sends.length, 0);
  }, options);
});

test("VK UI pairs a chat missing from the lookup by its command ID and accurately reports welcome delivery", async () => {
  for (const denied of [false, true]) await withSettings(async (page, { sends, settings, deliver }) => {
    await page.locator("#vk-notifications-token").fill(fixtureToken);
    await page.getByRole("button", { name: "Сохранить ключ" }).click();
    await page.locator("#vk-notifications-pair-start").waitFor({ state: "visible" });
    await page.locator("#vk-notifications-pair-start").click();
    await page.locator("#vk-notifications-pair-command-panel").waitFor({ state: "visible" });
    assert.equal(settings.get().peerId, null); assert.equal(sends.length, 0);
    deliver(`[club77|Магазин] ${await page.locator("#vk-notifications-pair-command").inputValue()}`);
    await page.waitForFunction(() => document.querySelector("#vk-notifications-connection").textContent.includes("Беседа: ID 2000000003"));
    assert.equal(settings.get().peerId, 2000000003); assert.equal(settings.get().enabled, false);
    assert.equal(sends.length, 1); assert.equal(sends[0].get("peer_ids"), "2000000003");
    assert.equal(await page.locator("#vk-notifications-pairing").isVisible(), false);
    const status = await page.locator("#vk-notifications-status").textContent();
    assert.equal(status.includes(fixtureToken), false);
    if (denied) { assert.match(status, /Тестовое сообщение не отправлено/); assert.equal(status.includes("Тестовое сообщение отправлено"), false); }
    else assert.match(status, /Тестовое сообщение отправлено/);
    await page.reload(); await page.locator("#vk-notifications-settings summary").click();
    await page.waitForFunction(() => document.querySelector("#vk-notifications-connection").textContent.includes("Беседа: ID 2000000003"));
    assert.equal(sends.length, 1);
  }, { noChats: true, chatDetails: { count: 0, items: [] }, denied });
});

test("VK UI explains the nightly pause and Forum Auto review alerts and shows 07:00 in Samara even for a UTC browser", async () => {
  await withSettings(async (page, { service, sends }) => {
    const text = await page.locator("#vk-notifications-settings").textContent();
    assert.match(text, /с 07:00 до 23:00 по самарскому времени \(UTC\+4\)/);
    assert.match(text, /Если заказ Forum Auto исчезнет[\s\S]*мог быть получен или отменён/);
    await page.locator("#vk-notifications-token").fill(fixtureToken);
    await page.getByRole("button", { name: "Сохранить ключ" }).click();
    await page.waitForFunction(() => !document.querySelector("#vk-notifications-enabled").disabled);
    await page.locator("#vk-notifications-enabled").check();
    await page.waitForFunction(() => document.querySelector("#vk-notifications-status").textContent.includes("Следующая:"));
    assert.match(await page.locator("#vk-notifications-status").textContent(), /18\.10\.2026, 07:00:00/);
    assert.equal(service.state().nextCheckAt, "2026-10-18T03:00:00.000Z");
    await service.runOnce(); assert.equal(sends.length, 1);
  }, { now: Date.parse("2026-10-17T23:05:00+04:00") });
});
