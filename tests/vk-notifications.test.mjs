import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { EncryptedVkSettings } from "../src/backend/notifications/encrypted-vk-settings.ts";
import { VkClient, VkError } from "../src/backend/notifications/vk-client.ts";
import { SqliteNotificationRepository } from "../src/backend/notifications/sqlite-notification-repository.ts";
import { OrderNotificationService, orderCheckIntervalMs } from "../src/backend/notifications/order-notification-service.ts";
import { monitoredOrders, formatOrderEvents } from "../src/backend/notifications/order-events.ts";
import { createAggregatorServer } from "../src/backend/http/create-server.ts";
import { parsePartKomOrderHistory } from "../src/backend/suppliers/part-kom/part-kom-order.ts";
import { parseArmtekOrderHistory } from "../src/backend/suppliers/armtek/armtek-order.ts";
import { SupplierAuthError, SupplierTimeoutError } from "../src/backend/errors.ts";

const now = Date.parse("2026-10-17T12:00:00Z");
const token = "vk1.a.fixture_secret_not_a_real_token";
const target = "77:2000000001";
const part = (fields = {}) => ({ article: "A1", brand: "TEST", title: "Фильтр", quantity: 10, price: 100,
  status: "В работе", fulfillment: "processing", expectedDate: null, guaranteedDate: null, warehouse: null, ...fields });
const history = (items = [part()], number = "ORDER-1", date = "2026-10-17") => ({ orders: [{ number, date, items }], limited: false });
const observe = (repository, value, supplier = "armtek", time = now) => repository.observe(target, [{ supplier, histories: Array.isArray(value) ? value : [value] }], time);
const response = (value) => new Response(JSON.stringify({ response: value }), { headers: { "Content-Type": "application/json" } });
const chats = [{ id: 2000000001, title: "Рабочая беседа" }];
const settingsValue = (fields = {}) => ({ token, groupId: 77, groupName: "Тестовое сообщество", chats, peerId: chats[0].id, enabled: false, ...fields });

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "aggregator-vk-"));
  const settings = new EncryptedVkSettings(join(directory, "vk.enc.json"), Buffer.alloc(32, 17));
  const repository = new SqliteNotificationRepository(join(directory, "orders.sqlite"));
  const calls = [];
  let current = history();
  let timestamp = now;
  const client = new VkClient(async (url, init) => {
    assert.equal(init.method, "POST"); assert.equal(init.redirect, "error"); assert.equal(url.includes(token), false);
    const params = new URLSearchParams(init.body);
    assert.equal(params.get("access_token"), token);
    calls.push({ method: url.split("/").at(-1), params, signal: init.signal });
    if (options.fetch) return options.fetch(url, init, calls);
    if (url.endsWith("groups.getTokenPermissions")) return response({ mask: 4096, permissions: [{ name: "messages", setting: 1 }] });
    if (url.endsWith("groups.getById")) return response({ groups: [{ id: 77, name: "Тестовое сообщество" }] });
    if (url.endsWith("messages.getConversations")) return response({ count: (options.chats ?? chats).length,
      items: (options.chats ?? chats).map((chat) => ({ conversation: { peer: { id: chat.id, type: "chat" }, can_write: { allowed: true }, chat_settings: { title: chat.title, state: "in" } } })) });
    if (url.endsWith("messages.send")) return response([{ peer_id: chats[0].id, message_id: 0, conversation_message_id: 123 }]);
    throw new Error("Unexpected fixture request");
  });
  const loads = [];
  const source = { available: (supplier) => (options.suppliers ?? ["armtek"]).includes(supplier),
    load: async (supplier, signal) => { loads.push(supplier); return options.load ? options.load(supplier, signal) : [current]; }, observe: () => {} };
  const service = new OrderNotificationService(settings, repository, client, source, () => timestamp);
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, settings, repository, service, calls, loads, client, setHistory: (value) => { current = value; }, advance: () => { timestamp += orderCheckIntervalMs; } };
}

test("monitor initializes each supplier without announcing old orders or terminal states", () => {
  const repository = new SqliteNotificationRepository(":memory:");
  try {
    for (const supplier of ["armtek", "part-kom", "forum-auto", "rossko"]) observe(repository, history([part({ fulfillment: "cancelled" })]), supplier);
    assert.deepEqual(repository.counts(target), { pending: 0, failed: 0 });
    observe(repository, history([part()], "ORDER-2"));
    const pending = repository.pending(target, now);
    assert.match(pending.text, /НОВЫЙ ЗАКАЗ · Armtek/); assert.match(pending.text, /ORDER-2/);
    repository.sent(pending.id);
    observe(repository, history([part()], "ORDER-2"));
    assert.equal(repository.pending(target, now), null);
    observe(repository, history([part({ fulfillment: "delivered" })], "OLDER", "2026-09-01"));
    assert.equal(repository.pending(target, now), null);
  } finally { repository.close(); }
});

test("one digest combines new orders, cancellation deltas and received quantities across suppliers", () => {
  const repository = new SqliteNotificationRepository(":memory:");
  try {
    repository.observe(target, ["armtek", "part-kom"].map((supplier) => ({ supplier, histories: [history()] })), now);
    repository.observe(target, [
      { supplier: "armtek", histories: [history([part({ fulfillment: "partial", cancelledQuantity: 2, deliveredQuantity: 3 })])] },
      { supplier: "part-kom", histories: [history([part({ quantity: 1 })], "NEW-ORDER")] },
    ], now);
    const pending = repository.pending(target, now);
    assert.match(pending.text, /ОТМЕНЕНО · Armtek[\s\S]*2 шт\. · 200 ₽/);
    assert.match(pending.text, /ПОЛУЧЕНО · Armtek[\s\S]*3 шт\. · 300 ₽/);
    assert.match(pending.text, /НОВЫЙ ЗАКАЗ · PartKOM/);
    assert.deepEqual(repository.counts(target), { pending: 1, failed: 0 });
    repository.sent(pending.id);
    observe(repository, history([part({ fulfillment: "partial", cancelledQuantity: 1, deliveredQuantity: 2 })]));
    observe(repository, { orders: [], limited: true });
    observe(repository, history([part({ fulfillment: "partial", cancelledQuantity: 2, deliveredQuantity: 3 })]));
    assert.equal(repository.pending(target, now), null);
    observe(repository, history([part({ fulfillment: "partial", cancelledQuantity: 4, deliveredQuantity: 5 })]));
    assert.match(repository.pending(target, now).text, /ПОЛУЧЕНО[\s\S]*2 шт\./);
  } finally { repository.close(); }
});

test("archive/current overlap, descriptions, missing rows and shipment do not invent receipt or cancellation", () => {
  const repository = new SqliteNotificationRepository(":memory:");
  try {
    observe(repository, history([part({ fulfillment: "in_transit" })]));
    for (const fulfillment of ["in_transit", "ready", "returned", "unknown"]) observe(repository, history([part({ fulfillment })]));
    assert.equal(repository.pending(target, now), null);
    const changed = history([part({ fulfillment: "partially_cancelled", fulfillmentQuantities: { delivered: 4, cancelled: 6 } })]);
    observe(repository, [changed, changed]);
    const pending = repository.pending(target, now);
    assert.match(pending.text, /6 шт\./); assert.match(pending.text, /4 шт\./); assert.doesNotMatch(pending.text, /12 шт\.|8 шт\./);
    repository.sent(pending.id);
    observe(repository, history([part({ fulfillment: "partial", cancelledQuantity: 6, deliveredQuantity: 4, title: "Другое описание", price: 200 })]));
    assert.equal(repository.pending(target, now), null);
  } finally { repository.close(); }
});

test("malformed supplier responses cannot establish a baseline or consume an event", () => {
  const repository = new SqliteNotificationRepository(":memory:");
  try {
    assert.throws(() => observe(repository, history([part({ quantity: NaN })])));
    observe(repository, history());
    assert.throws(() => observe(repository, history([part({ fulfillment: "partial", deliveredQuantity: 8, cancelledQuantity: 4 })])));
    observe(repository, history([part({ fulfillment: "cancelled" })]));
    assert.match(repository.pending(target, now).text, /ОТМЕНЕНО/);
  } finally { repository.close(); }
});

test("outbox and baselines survive restart; retries keep the same random_id and destination", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aggregator-vk-restart-"));
  const path = join(directory, "orders.sqlite");
  let repository = new SqliteNotificationRepository(path);
  t.after(async () => { repository.close(); await rm(directory, { recursive: true, force: true }); });
  observe(repository, history()); observe(repository, history([part({ fulfillment: "cancelled" })]));
  const original = repository.pending(target, now);
  repository.retry(original.id, 0, now, false);
  assert.equal(repository.pending(target, now), null);
  repository.close(); repository = new SqliteNotificationRepository(path);
  const restored = repository.pending(target, now + 60_000);
  assert.equal(restored.randomId, original.randomId); assert.equal(restored.text, original.text);
  assert.equal(repository.pending("OTHER:2000000001", now + 60_000), null);
  repository.retry(restored.id, restored.attempts, now, true);
  assert.deepEqual(repository.counts(target), { pending: 0, failed: 1 });
  repository.retryFailed(target);
  assert.equal(repository.pending(target, now).randomId, original.randomId);
});

test("formatter splits long digests safely and omits unknown prices", () => {
  const items = Array.from({ length: 30 }, (_, index) => ({ article: `A${index}`, brand: "TEST", title: "Деталь ".repeat(60), quantity: 2, price: null }));
  const messages = formatOrderEvents([{ supplier: "armtek", number: "ORDER\nINJECTED", kind: "received", items }]);
  assert.ok(messages.length > 1); assert.ok(messages.every((message) => message.length <= 3800));
  assert.equal(messages.join("\n").includes("₽"), false);
  assert.equal(messages.join("\n").includes("ORDER\nINJECTED"), false);
  assert.equal(messages.join("\n").match(/2 шт\./g).length, 30);
});

test("different prices for the same unidentified part never produce an invented total", () => {
  const result = monitoredOrders(history([part({ quantity: 1, price: 100 }), part({ quantity: 2, price: 200 })]));
  const combined = Object.values(result[0].items)[0];
  assert.equal(combined.quantity, 3); assert.equal(combined.price, null);
  assert.equal(formatOrderEvents([{ supplier: "armtek", number: "ORDER", kind: "new", items: [combined] }])[0].includes("₽"), false);
});

test("supplier adapters expose actual partial receipt without interpreting shipment as receipt", () => {
  const partkom = parsePartKomOrderHistory([{ orderNumber: "P", detailNum: "A1", quantity: 10, releaseCount: 3, refusalCount: 2 }]);
  assert.equal(partkom.orders[0].items[0].deliveredQuantity, 3);
  assert.equal(monitoredOrders(partkom)[0].items[JSON.stringify(["part", null, "A1"])].received, 3);
  const armtek = parseArmtekOrderHistory({ DATA: [{ ORDER: "A", PIN: "A1", ZZKWMENG: "10", KWMENG: "10", Issued: "3", REJECTED: "2" }] });
  assert.equal(armtek.orders[0].items[0].deliveredQuantity, 3);
});

test("VK settings are encrypted, fail closed on missing or wrong master key and never expose the token", async (t) => {
  const f = await fixture(t);
  f.settings.set(settingsValue());
  const file = await readFile(join(f.directory, "vk.enc.json"), "utf8");
  assert.equal(file.includes(token), false);
  assert.equal(new EncryptedVkSettings(join(f.directory, "vk.enc.json"), Buffer.alloc(32, 17)).get().token, token);
  assert.throws(() => new EncryptedVkSettings(join(f.directory, "vk.enc.json"), null), /required/);
  assert.throws(() => new EncryptedVkSettings(join(f.directory, "vk.enc.json"), Buffer.alloc(32, 18)), /decrypted/);
  assert.equal(JSON.stringify(f.service.state()).includes(token), false);
  const memoryOnly = new EncryptedVkSettings(join(f.directory, "absent.json"), null);
  assert.throws(() => memoryOnly.set(settingsValue()), /шифрование/);
});

test("saving only the community token discovers a single chat and leaves all sending disabled", async (t) => {
  const f = await fixture(t);
  const state = await f.service.connect(token, new AbortController().signal);
  assert.equal(state.peerId, chats[0].id); assert.equal(state.enabled, false);
  await f.service.runOnce(); assert.equal(f.loads.length, 0);
  assert.deepEqual(f.calls.map((call) => call.method), ["groups.getTokenPermissions", "groups.getById", "messages.getConversations"]);
  assert.equal(JSON.stringify(state).includes(token), false);
  assert.throws(() => f.service.configure({ enabled: true, peerId: 2000000099 }), /Выберите/);
});

test("multiple or missing chats never cause an arbitrary recipient to be selected", async (t) => {
  const f = await fixture(t, { chats: [...chats, { id: 2000000002, title: "Другой чат" }] });
  const state = await f.service.connect(token, new AbortController().signal);
  assert.equal(state.peerId, null);
  assert.throws(() => f.service.configure({ enabled: true }), /Выберите/);
  assert.equal(f.service.configure({ enabled: false, peerId: 2000000002 }).peerId, 2000000002);
  const empty = await fixture(t, { chats: [] });
  assert.equal((await empty.service.connect(token, new AbortController().signal)).peerId, null);
  assert.throws(() => empty.service.configure({ enabled: true }), /Выберите/);
});

test("fixed ten-minute scheduler resumes deferred reads without re-fetching already checked suppliers", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = await fixture(t);
  f.settings.set(settingsValue({ enabled: true }));
  const release = f.service.beginForegroundOperation();
  f.service.start(); await f.service.runOnce(); assert.equal(f.loads.length, 0);
  release(); await f.service.runOnce(); assert.equal(f.loads.length, 1);
  await f.service.runOnce(); assert.equal(f.loads.length, 1);
  t.mock.timers.tick(orderCheckIntervalMs - 1); assert.equal(f.loads.length, 1);
  f.advance(); t.mock.timers.tick(1); await f.service.runOnce(); assert.equal(f.loads.length, 2);
  f.service.stop(); t.mock.timers.tick(orderCheckIntervalMs); assert.equal(f.loads.length, 2);
});

test("a truncated list of community dialogs never auto-selects its only visible chat", async (t) => {
  const f = await fixture(t, { fetch: async (url, init) => {
    if (url.endsWith("groups.getTokenPermissions")) return response({ mask: 4096, permissions: [] });
    if (url.endsWith("groups.getById")) return response({ groups: [{ id: 77, name: "Тестовое сообщество" }] });
    assert.ok(url.endsWith("messages.getConversations"));
    const offset = Number(new URLSearchParams(init.body).get("offset"));
    return response({ count: 1001, items: Array.from({ length: 50 }, (_, index) => ({ conversation: offset === 0 && index === 0
      ? { peer: { id: chats[0].id, type: "chat" }, can_write: { allowed: true }, chat_settings: { title: chats[0].title, state: "in" } }
      : { peer: { id: offset + index + 1, type: "user" } } })) });
  } });
  const state = await f.service.connect(token, new AbortController().signal);
  assert.equal(state.chats.length, 1); assert.equal(state.peerId, null); assert.equal(state.enabled, false);
  assert.equal(f.calls.filter((call) => call.method === "messages.getConversations").length, 20);
  assert.equal(f.service.configure({ enabled: false, peerId: chats[0].id }).peerId, chats[0].id);
});

test("failed deliveries persist and retry the same VK random_id; permanent errors pause delivery until re-enabled", async (t) => {
  let failure = true; const delivered = [];
  const f = await fixture(t, { fetch: async (url, init) => {
    assert.ok(url.endsWith("messages.send"));
    delivered.push(new URLSearchParams(init.body).get("random_id"));
    if (failure) return new Response(JSON.stringify({ error: { error_code: 5, error_msg: token } }), { headers: { "Content-Type": "application/json" } });
    return response([{ peer_id: chats[0].id, message_id: 0, conversation_message_id: 123 }]);
  } });
  f.settings.set(settingsValue({ enabled: true }));
  await f.service.runOnce(); f.advance();
  f.setHistory(history([part({ fulfillment: "cancelled" })])); await f.service.runOnce();
  assert.equal(f.service.state().failed, 1); assert.equal(f.service.state().pending, 0);
  f.advance(); await f.service.runOnce(); assert.equal(delivered.length, 1);
  failure = false; f.service.configure({ enabled: true }); await f.service.runOnce();
  assert.equal(delivered.length, 2); assert.equal(delivered[0], delivered[1]);
  assert.equal(f.service.state().failed, 0); assert.equal(f.service.state().pending, 0);
});

test("connection cancellation or disconnect cannot restore a late key", async (t) => {
  let started; const ready = new Promise((resolve) => { started = resolve; });
  const f = await fixture(t, { fetch: async (_url, init) => { started(); await new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })); } });
  const connecting = f.service.connect(token, new AbortController().signal);
  const rejected = assert.rejects(connecting);
  await ready; f.service.disconnect(); await rejected;
  assert.equal(f.settings.get(), null); assert.equal(f.service.state().configured, false);
});

test("VK requests have bounded timeouts and an already aborted request sends nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const client = new VkClient(async (_url, init) => { calls++;
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  });
  const rejected = assert.rejects(client.send(token, 77, chats[0].id, "Текст", 123, new AbortController().signal), VkError);
  t.mock.timers.tick(12_000); await rejected;
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.send(token, 77, chats[0].id, "Текст", 123, controller.signal));
  assert.equal(calls, 1);
});

test("worker runs without any browser, combines changes and never overlaps or polls during foreground work", async (t) => {
  const f = await fixture(t);
  f.settings.set(settingsValue({ enabled: true }));
  const release = f.service.beginForegroundOperation();
  await f.service.runOnce(); assert.equal(f.loads.length, 0); release(); release();
  await f.service.runOnce(); assert.equal(f.loads.length, 1); assert.equal(f.calls.length, 0);
  f.advance(); f.setHistory(history([part({ fulfillment: "partial", cancelledQuantity: 2, deliveredQuantity: 3 })]));
  const first = f.service.runOnce(); const second = f.service.runOnce(); assert.equal(first, second);
  await first;
  const sends = f.calls.filter((call) => call.method === "messages.send"); assert.equal(sends.length, 1);
  assert.match(sends[0].params.get("message"), /ОТМЕНЕНО[\s\S]*ПОЛУЧЕНО/);
  assert.equal(sends[0].params.get("peer_ids"), "2000000001");
  f.advance(); await f.service.runOnce(); assert.equal(f.calls.length, 1);
  assert.equal(Date.parse(f.service.state().nextCheckAt) - Date.parse(f.service.state().lastCheckAt), orderCheckIntervalMs);
});

test("one failed supplier does not stop other suppliers or initialize its baseline", async (t) => {
  const f = await fixture(t, { suppliers: ["armtek", "rossko"], load: async (supplier) => {
    if (supplier === "armtek") throw new Error("private upstream token"); return [history()];
  } });
  f.settings.set(settingsValue({ enabled: true })); await f.service.runOnce();
  assert.equal(f.service.state().suppliers.find((item) => item.supplier === "rossko").error, null);
  assert.match(f.service.state().suppliers.find((item) => item.supplier === "armtek").error, /Не удалось/);
  assert.equal(JSON.stringify(f.service.state()).includes("private"), false);
});

test("monitor distinguishes missing supplier authorization and timeouts without exposing upstream details", async (t) => {
  for (const [error, expected] of [[new SupplierAuthError("private token"), /авторизацию Armtek/], [new SupplierTimeoutError("private host"), /не ответил вовремя/]]) {
    const f = await fixture(t, { load: async () => { throw error; } });
    f.settings.set(settingsValue({ enabled: true })); await f.service.runOnce();
    const state = f.service.state(); assert.match(state.suppliers[0].error, expected);
    assert.equal(JSON.stringify(state).includes("private"), false);
  }
});

test("shutdown aborts pending supplier IO and waits before closing storage", async (t) => {
  let started; const ready = new Promise((resolve) => { started = resolve; });
  let received;
  const f = await fixture(t, { load: async (_supplier, signal) => { received = signal; started();
    await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  f.settings.set(settingsValue({ enabled: true })); const work = f.service.runOnce(); await ready;
  f.service.stop(); await work; assert.equal(received.aborted, true); assert.equal(f.calls.length, 0);
});

test("VK transport sanitizes API failures, rejects redirects, malformed JSON and oversized responses", async () => {
  for (const body of [{ error: { error_code: 5, error_msg: token } }, { response: null }, "not-json"]) {
    const client = new VkClient(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
    await assert.rejects(() => client.send(token, 77, chats[0].id, "Сообщение", 123, new AbortController().signal), (error) => error instanceof VkError && !error.message.includes(token));
  }
  const huge = new VkClient(async () => new Response("x".repeat(2_097_153), { headers: { "Content-Type": "application/json" } }));
  await assert.rejects(() => huge.send(token, 77, chats[0].id, "Текст", 123, new AbortController().signal), /размер/);
});

test("VK settings HTTP validates bodies, protects secrets and separates setup from enabling delivery", async (t) => {
  let server;
  t.after(async () => { if (server?.listening) { server.close(); await once(server, "close"); } });
  const f = await fixture(t);
  const application = { streamSearch: async () => {} };
  const previousPath = process.env.GARAGE_DB_PATH;
  process.env.GARAGE_DB_PATH = join(f.directory, "garage.sqlite");
  try { server = createAggregatorServer({ application, publicDir: join(process.cwd(), "src/frontend"), notifications: f.service, reportError: () => {} }); }
  finally { if (previousPath === undefined) delete process.env.GARAGE_DB_PATH; else process.env.GARAGE_DB_PATH = previousPath; }
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/api/notifications/vk`;
  const save = (body, headers = {}) => fetch(url, { method: "PUT", headers: { "Content-Type": "application/json", ...headers }, body });
  assert.equal((await save("bad-json")).status, 400);
  assert.equal((await save(JSON.stringify({ token: "bad" }))).status, 400);
  assert.equal((await save(JSON.stringify({ token }), { "Sec-Fetch-Site": "cross-site" })).status, 403);
  const saved = await save(JSON.stringify({ token })); assert.equal(saved.status, 200);
  assert.equal(saved.headers.get("cache-control"), "no-store");
  const state = await saved.json(); assert.equal(state.enabled, false); assert.equal(JSON.stringify(state).includes(token), false);
  assert.equal((await fetch(`${url}/state`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true, peerId: 2000000099 }) })).status, 400);
  assert.equal((await fetch(url, { method: "DELETE" })).status, 200);
  assert.equal((await (await fetch(url)).json()).configured, false);
});
