import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createCipheriv } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { EncryptedVkSettings } from "../src/backend/notifications/encrypted-vk-settings.ts";
import { VkClient, VkError } from "../src/backend/notifications/vk-client.ts";
import { SqliteNotificationRepository } from "../src/backend/notifications/sqlite-notification-repository.ts";
import { OrderNotificationService, orderCheckIntervalMs } from "../src/backend/notifications/order-notification-service.ts";
import { monitoredOrders, formatOrderEvents } from "../src/backend/notifications/order-events.ts";
import { createAggregatorServer } from "../src/backend/http/create-server.ts";
import { parsePartKomOrderHistory } from "../src/backend/suppliers/part-kom/part-kom-order.ts";
import { parseArmtekOrderHistory } from "../src/backend/suppliers/armtek/armtek-order.ts";
import { parseForumAutoOrderHistory } from "../src/backend/suppliers/forum-auto/forum-auto-api-adapter.ts";
import { SupplierAuthError, SupplierTimeoutError } from "../src/backend/errors.ts";
import { nextOrderCheckTime } from "../src/backend/notifications/order-check-schedule.ts";
import { OrderCancellationService } from "../src/backend/purchasing/order-cancellation-service.ts";
import { SqliteOrderCancellationRepository } from "../src/backend/purchasing/sqlite-order-cancellation-repository.ts";

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
const pollResponse = (value, type = "application/json") => new Response(JSON.stringify(value), { headers: { "Content-Type": type } });
const chatMessage = (text, fields = {}) => ({ type: "message_new", group_id: 77,
  object: { message: { peer_id: 2000000003, from_id: 123, out: 0, text, ...fields } } });
async function waitForState(service, check) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (check(service.state())) return service.state();
    await new Promise(setImmediate);
  }
  assert.fail("Notification service did not reach the expected state");
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "aggregator-vk-"));
  const settings = new EncryptedVkSettings(join(directory, "vk.enc.json"), Buffer.alloc(32, 17));
  const repository = new SqliteNotificationRepository(join(directory, "orders.sqlite"));
  const calls = [];
  let current = history();
  let timestamp = now;
  const client = new VkClient(async (url, init) => {
    if (new URL(url).hostname === "lp.vk.com") {
      assert.equal(init.method, "GET"); assert.equal(init.redirect, "error"); assert.equal(url.includes(token), false);
      const params = new URL(url).searchParams;
      calls.push({ method: "longpoll", params, signal: init.signal });
      if (options.poll) return options.poll(params, init);
      throw new Error("Unexpected Long Poll fixture request");
    }
    assert.equal(init.method, "POST"); assert.equal(init.redirect, "error"); assert.equal(url.includes(token), false);
    const params = new URLSearchParams(init.body);
    assert.equal(params.get("access_token"), token);
    calls.push({ method: url.split("/").at(-1), params, signal: init.signal });
    if (options.fetch) return options.fetch(url, init, calls);
    const apiError = options.apiErrors?.[url.split("/").at(-1)];
    if (apiError !== undefined) return pollResponse({ error: { error_code: apiError, error_msg: token } });
    if (url.endsWith("groups.getTokenPermissions")) return response({ mask: 4096, permissions: [{ name: "messages", setting: 1 }] });
    if (url.endsWith("groups.getById")) return response({ groups: [{ id: 77, name: "Тестовое сообщество" }] });
    if (url.endsWith("messages.getConversations")) return response({ count: (options.chats ?? chats).length,
      items: (options.chats ?? chats).map((chat) => ({ conversation: { peer: { id: chat.id, type: "chat" }, can_write: { allowed: true }, chat_settings: { title: chat.title, state: "in" } } })) });
    if (url.endsWith("groups.getLongPollSettings")) return response(options.pollSettings ?? { is_enabled: true, api_version: "5.199", events: { message_new: 1 } });
    if (url.endsWith("groups.getLongPollServer")) return response(options.pollServer ?? { server: "https://lp.vk.com/whp/77", key: "fixture_ephemeral_key", ts: "1" });
    if (url.endsWith("messages.getConversationsById")) return response(options.chatDetails ?? { items: [{ peer: { id: Number(params.get("peer_ids")), type: "chat" }, chat_settings: { state: "in", title: "Автосервис" } }] });
    if (url.endsWith("messages.send")) return options.send ? options.send(params, init)
      : response([{ peer_id: Number(params.get("peer_ids")), message_id: 0, conversation_message_id: 123 }]);
    throw new Error("Unexpected fixture request");
  });
  const loads = [];
  const source = { available: (supplier) => (options.suppliers ?? ["armtek"]).includes(supplier),
    load: async (supplier, signal) => { loads.push(supplier); return options.load ? options.load(supplier, signal) : [current]; },
    observe: (supplier, value) => options.observe?.(supplier, value) };
  const service = new OrderNotificationService(settings, repository, client, source, () => timestamp);
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, settings, repository, service, calls, loads, client, setHistory: (value) => { current = value; },
    setTime: (value) => { timestamp = value; }, advance: (duration = orderCheckIntervalMs) => { timestamp += duration; } };
}

async function withCancellationHistoryServer(t, supplier, getHistory, options = {}) {
  let server; let cancellations;
  t.after(async () => {
    if (server?.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    cancellations?.close();
  });
  const f = await fixture(t, { ...options, suppliers: [supplier], load: options.load ?? (async () => [getHistory()]),
    observe: (id, value) => cancellations.observe(id, value) });
  const databasePath = join(f.directory, "orders.sqlite");
  cancellations = new OrderCancellationService(new SqliteOrderCancellationRepository(databasePath));
  const previous = process.env.GARAGE_DB_PATH;
  process.env.GARAGE_DB_PATH = databasePath;
  try {
    server = createAggregatorServer({ publicDir: join(process.cwd(), "src/frontend"), notifications: f.service,
      application: { streamSearch: async () => {}, partKomOrderHistory: async () => getHistory(), supplierOrderHistory: async () => getHistory() } });
  } finally { if (previous === undefined) delete process.env.GARAGE_DB_PATH; else process.env.GARAGE_DB_PATH = previous; }
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { ...f, origin: `http://127.0.0.1:${server.address().port}` };
}

test("website events persist, paginate without gaps and keep arrivals after a read snapshot unread", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aggregator-order-feed-"));
  const path = join(directory, "orders.sqlite");
  let repository = new SqliteNotificationRepository(path);
  t.after(async () => { repository.close(); await rm(directory, { recursive: true, force: true }); });
  const update = (value) => repository.observeFeed([{ supplier: "armtek", histories: [value] }], now);
  update(history()); assert.equal(repository.feed().entries.length, 0);
  for (let index = 1; index <= 35; index++) update(history([part()], `NEW-${index}`));
  const first = repository.feed();
  assert.equal(first.unreadCount, 35); assert.equal(first.entries.length, 30);
  const second = repository.feed(first.nextBefore);
  assert.equal(second.entries.length, 5); assert.equal(second.nextBefore, null);
  assert.equal(new Set([...first.entries, ...second.entries].map((entry) => entry.id)).size, 35);
  const changed = history([part({ fulfillment: "partial", cancelledQuantity: 2, deliveredQuantity: 3 })]);
  update(changed); repository.markFeedSeen(first.latestId, now);
  const pending = repository.feed();
  assert.equal(pending.unreadCount, 2);
  assert.equal(pending.unreadCancellationCount, 1);
  assert.deepEqual(pending.entries.slice(0, 2).map((entry) => [entry.kind, entry.items[0].quantity]), [["cancelled", 2], ["received", 3]]);
  assert.deepEqual(repository.counts(target), { pending: 0, failed: 0 }, "website events never enter the VK outbox");
  repository.close(); repository = new SqliteNotificationRepository(path);
  update(changed);
  assert.deepEqual(repository.feed(), pending, "restart and repeated responses cannot duplicate a website event");
});

test("selective website reads preserve unseen neighbours, pagination and persisted read state", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aggregator-selective-feed-"));
  const path = join(directory, "orders.sqlite");
  let repository = new SqliteNotificationRepository(path);
  t.after(async () => { repository.close(); await rm(directory, { recursive: true, force: true }); });
  const update = (number) => repository.observeFeed([{ supplier: "armtek", histories: [history([part()], number)] }], now);
  update("BASE");
  for (let index = 1; index <= 35; index++) update(`NEW-${index}`);
  const first = repository.feed();
  const older = repository.feed(first.nextBefore);
  const ids = [first.entries[0].id, first.entries[2].id, older.entries.at(-1).id];
  assert.equal(repository.markFeedEntriesSeen(ids, now), true);
  assert.equal(repository.markFeedEntriesSeen(ids, now), true, "repeated acknowledgements are idempotent");
  update("ARRIVED-AFTER");
  repository.close(); repository = new SqliteNotificationRepository(path);
  const current = repository.feed();
  const all = [...current.entries, ...repository.feed(current.nextBefore).entries];
  assert.equal(current.unreadCount, 33);
  assert.deepEqual(all.filter((entry) => entry.read).map((entry) => entry.id).sort((a, b) => a - b), ids.sort((a, b) => a - b));
  assert.equal(repository.markFeedEntriesSeen([ids[0], current.latestId + 1], now), false);
  assert.equal(repository.feed().unreadCount, 33);
});

test("the website monitor works without a VK key and respects the same night pause", async (t) => {
  const f = await fixture(t);
  await f.service.runOnce(); assert.equal(f.loads.length, 1); assert.equal(f.service.orderFeed().unreadCount, 0);
  f.advance(); f.setHistory(history([part({ fulfillment: "partial", cancelledQuantity: 2, deliveredQuantity: 3 })]));
  await f.service.runOnce(); assert.equal(f.loads.length, 2); assert.equal(f.service.orderFeed().unreadCount, 2);
  assert.equal(f.calls.length, 0); assert.equal(f.service.state().configured, false);
  f.setTime(Date.parse("2026-10-17T19:00:00Z")); await f.service.runOnce(); assert.equal(f.loads.length, 2);
  f.setTime(Date.parse("2026-10-18T03:00:00Z")); await f.service.runOnce(); assert.equal(f.loads.length, 3);
  assert.equal(f.service.orderFeed().entries.length, 2);
});

test("reading the website feed cannot consume a queued VK event or reset its retry identity", async (t) => {
  let unavailable = true;
  const f = await fixture(t, { send: async (params) => {
    if (unavailable) throw new Error("Fixture network failure");
    return response([{ peer_id: Number(params.get("peer_ids")), message_id: 0, conversation_message_id: 42 }]);
  } });
  f.settings.set(settingsValue({ enabled: true })); await f.service.runOnce();
  f.advance(); f.setHistory(history([part({ fulfillment: "cancelled" })])); await f.service.runOnce();
  const id = f.calls.at(-1).params.get("random_id");
  assert.equal(f.service.orderFeed().unreadCount, 1); assert.equal(f.repository.counts(target).pending, 1);
  f.service.markOrdersSeen({ ids: [f.service.orderFeed().latestId] });
  unavailable = false; f.advance(); await f.service.runOnce();
  assert.equal(f.service.orderFeed().unreadCount, 0); assert.equal(f.service.orderFeed().entries.length, 1);
  assert.equal(f.calls.at(-1).params.get("random_id"), id); assert.equal(f.repository.counts(target).pending, 0);
});

test("website feed HTTP validates cursors and acknowledgements and never checks suppliers on a read", async (t) => {
  const f = await withCancellationHistoryServer(t, "armtek", () => history());
  f.repository.observeFeed([{ supplier: "armtek", histories: [history()] }], now);
  f.repository.observeFeed([{ supplier: "armtek", histories: [history([part({ fulfillment: "cancelled" })])] }], now);
  const url = `${f.origin}/api/notifications/orders`;
  const first = await fetch(url); assert.equal(first.status, 200); assert.equal(first.headers.get("cache-control"), "no-store");
  const view = await first.json(); assert.equal(view.unreadCount, 1); assert.equal(f.loads.length, 0); assert.equal(f.calls.length, 0);
  for (const query of ["?bad=1", "?before=-1", "?before=1&before=2", "?before=9007199254740992", "?before=1.2",
    "?priority=1", "?before=1&priority=2", "?before=1&priority=", "?before=1&priority=1&priority=0"]) assert.equal((await fetch(url + query)).status, 400);
  assert.equal((await fetch(`${url}?before=${view.latestId}&priority=1`)).status, 200);
  const post = (payload, headers = {}) => fetch(`${url}/seen`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(payload) });
  for (const payload of [{ throughId: "1" }, { throughId: 1, bad: true }, { throughId: view.latestId + 1 }, [], {},
    { ids: [] }, { ids: [0] }, { ids: [-1] }, { ids: ["1"] }, { ids: [1, 1] }, { ids: [view.latestId + 1] },
    { ids: [view.latestId], throughId: view.latestId }, { ids: Array.from({ length: 101 }, (_, index) => index + 1) }]) {
    assert.equal((await post(payload)).status, 400);
  }
  assert.equal((await post({ ids: [view.latestId] }, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await post({ throughId: view.latestId }, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await fetch(`${url}/seen`)).status, 405);
  f.repository.observeFeed([{ supplier: "rossko", histories: [history()] }], now);
  f.repository.observeFeed([{ supplier: "rossko", histories: [history([part()], "NEW-ROSSKO")] }], now);
  const read = await post({ throughId: view.latestId }); assert.equal(read.status, 200);
  const result = await read.json(); assert.equal(result.unreadCount, 1);
  assert.equal(result.entries.find((entry) => entry.id === view.latestId).read, true);
  assert.equal(result.entries.find((entry) => entry.kind === "new").read, false);
  assert.equal(result.unreadCancellationCount, 0);
  assert.equal(f.loads.length, 0); assert.equal(f.calls.length, 0);
});

test("only unread cancellations precede newer events and pagination survives reading its cursor", () => {
  const repository = new SqliteNotificationRepository(":memory:");
  const update = (value) => repository.observeFeed([{ supplier: "armtek", histories: [value] }], now);
  try {
    update(history());
    for (let index = 0; index < 35; index++) {
      update(history([part()], `CANCEL-${index}`));
      update(history([part({ fulfillment: "cancelled" })], `CANCEL-${index}`));
    }
    for (let index = 0; index < 55; index++) update(history([part()], `ORDINARY-${index}`));
    const first = repository.feed();
    assert.equal(first.unreadCancellationCount, 35);
    assert.ok(first.entries.every((entry) => entry.kind === "cancelled"));
    const all = [];
    let page = first;
    for (let index = 0; index < 10; index++) {
      all.push(...page.entries);
      if (page.nextBefore === null) break;
      page = repository.feed(page.nextBefore, page.nextBeforePriority);
    }
    assert.equal(all.length, 125);
    assert.equal(new Set(all.map((entry) => entry.id)).size, 125);
    assert.ok(all.slice(0, 35).every((entry) => entry.kind === "cancelled"));
    assert.ok(all.slice(35).every((entry) => entry.kind === "new"));
    for (const group of [all.slice(0, 35), all.slice(35)]) {
      assert.deepEqual(group.map((entry) => entry.id), group.map((entry) => entry.id).sort((a, b) => b - a));
    }
    repository.markFeedEntriesSeen(first.entries.map((entry) => entry.id), now);
    assert.equal(repository.feed().unreadCancellationCount, 5);
    const next = repository.feed(first.nextBefore, first.nextBeforePriority);
    assert.ok(next.entries.slice(0, 5).every((entry) => entry.kind === "cancelled" && !entry.read));
    assert.equal(next.nextBeforePriority, 0);
    const ids = new Set(first.entries.map((entry) => entry.id));
    page = next;
    for (let index = 0; index < 10; index++) {
      for (const entry of page.entries) ids.add(entry.id);
      repository.markFeedEntriesSeen(page.entries.map((entry) => entry.id), now);
      if (page.nextBefore === null) break;
      page = repository.feed(page.nextBefore, page.nextBeforePriority);
    }
    assert.equal(ids.size, 125, "reading and priority changes cannot skip a notification");
    repository.markFeedSeen(first.latestId, now);
    const read = repository.feed();
    assert.equal(read.unreadCancellationCount, 0);
    assert.equal(read.nextBeforePriority, 0);
    assert.deepEqual(read.entries.map((entry) => entry.id), Array.from({ length: 30 }, (_, index) => 125 - index));
    assert.ok(read.entries.every((entry) => entry.kind === "new"));
  } finally { repository.close(); }
});

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

test("reading a supplier cancellation in the aggregator before the monitor detects it does not suppress its VK notification", async (t) => {
  for (const supplier of ["armtek", "part-kom", "forum-auto", "rossko"]) {
    let current = history();
    const f = await withCancellationHistoryServer(t, supplier, () => current);
    f.settings.set(settingsValue({ enabled: true })); await f.service.runOnce();
    current = history([part({ fulfillment: "partially_cancelled", cancelledQuantity: 2 })]);
    const query = supplier === "armtek" ? "?from=2026-10-01&to=2026-10-17" : "";
    const loaded = await fetch(`${f.origin}/api/order-history/${supplier}${query}`); assert.equal(loaded.status, 200); await loaded.json();
    const inbox = await (await fetch(`${f.origin}/api/order-cancellations`)).json(); assert.equal(inbox.total, 1);
    const seen = await fetch(`${f.origin}/api/order-cancellations/seen`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notices: inbox.notices.map(({ id, revision }) => ({ id, revision })) }) });
    assert.equal(seen.status, 200); assert.equal((await seen.json()).total, 0);
    assert.equal(f.calls.length, 0); await new Promise(setImmediate);
    f.advance(); await f.service.runOnce();
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].params.get("peer_ids"), "2000000001");
    assert.match(f.calls[0].params.get("message"), /ОТМЕНЕНО[\s\S]*Заказ № ORDER-1[\s\S]*2 шт\./);
    assert.equal((await (await fetch(`${f.origin}/api/order-cancellations`)).json()).total, 0);
    f.advance(); await f.service.runOnce(); assert.equal(f.calls.length, 1);
  }
});

test("acknowledging a queued cancellation leaves VK delivery and its persisted retry identifier intact", async (t) => {
  let current = history(); let unavailable = true;
  const f = await withCancellationHistoryServer(t, "part-kom", () => current, { send: async (params) => {
    if (unavailable) throw new Error("Fixture temporary VK failure");
    return response([{ peer_id: Number(params.get("peer_ids")), message_id: 0, conversation_message_id: 123 }]);
  } });
  f.settings.set(settingsValue({ enabled: true })); await f.service.runOnce();
  current = history([part({ fulfillment: "cancelled" })]); f.advance(); await f.service.runOnce();
  const queued = f.repository.pending(target, now + 2 * orderCheckIntervalMs); assert.ok(queued);
  const inbox = await (await fetch(`${f.origin}/api/order-cancellations`)).json(); assert.equal(inbox.total, 1);
  const seen = await fetch(`${f.origin}/api/order-cancellations/seen`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notices: inbox.notices.map(({ id, revision }) => ({ id, revision })) }) });
  assert.equal((await seen.json()).total, 0);
  assert.deepEqual(f.repository.pending(target, now + 2 * orderCheckIntervalMs), queued);
  unavailable = false; await new Promise(setImmediate); f.advance(); await f.service.runOnce();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0].params.get("random_id"), f.calls[1].params.get("random_id"));
  assert.match(f.calls[1].params.get("message"), /ОТМЕНЕНО · PartKOM/);
  assert.equal(f.repository.counts(target).pending, 0);
  assert.equal((await (await fetch(`${f.origin}/api/order-cancellations`)).json()).total, 0);
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

test("Forum Auto document and status changes never announce disappearance or new orders in either destination", () => {
  const repository = new SqliteNotificationRepository(":memory:");
  const row = { did: 123, nr: null, dtc: "17.10.2026 12:30:00", statusId: 30, status: "Подтвержден",
    arTovs: [{ nr: "A1", brand: "TEST", tovname: "Фильтр", k1: 2, k3: 0, price: 100 }] };
  const record = (rows) => {
    const histories = [parseForumAutoOrderHistory(rows)];
    repository.observe(target, [{ supplier: "forum-auto", histories }], now);
    repository.observeFeed([{ supplier: "forum-auto", histories }], now);
  };
  try {
    record([row, { ...row, did: 456 }]);
    for (const nr of ["DOC-1", "DOC-2", null]) {
      record([{ ...row, nr, statusId: 50, status: "На комплектации" }, { ...row, did: 456, nr }]);
      assert.equal(repository.pending(target, now), null);
      assert.equal(repository.feed().unreadCount, 0);
    }
    record([{ ...row, did: 456 }]);
    assert.match(repository.pending(target, now).text, /ТРЕБУЕТ ПРОВЕРКИ · Forum Auto\nЗаказ № 123\n/);
    assert.doesNotMatch(repository.pending(target, now).text, /Заказ № 456|НОВЫЙ ЗАКАЗ/);
    assert.deepEqual(repository.feed().entries.map(({ number, kind }) => [number, kind]), [["123", "missing"]]);
    repository.sent(repository.pending(target, now).id);
    record([{ ...row, did: 456 }]);
    assert.equal(repository.pending(target, now), null);
    assert.equal(repository.feed().entries.length, 1);
  } finally { repository.close(); }
});

test("legacy Forum Auto document snapshots are rebaselined quietly for VK and the feed without resetting other suppliers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aggregator-forum-identity-upgrade-"));
  const path = join(directory, "orders.sqlite");
  let repository = new SqliteNotificationRepository(path);
  t.after(async () => { repository.close(); await rm(directory, { recursive: true, force: true }); });
  const record = (supplier, value) => {
    repository.observe(target, [{ supplier, histories: [value] }], now);
    repository.observeFeed([{ supplier, histories: [value] }], now);
  };
  record("armtek", history());
  repository.close();
  const legacy = new DatabaseSync(path);
  try {
    for (const destination of [target, "aggregator-order-feed"]) {
      legacy.prepare("INSERT INTO vk_order_monitor_baseline VALUES (?, 'forum-auto', '2026-10-15')").run(destination);
      for (const number of ["123", "OLD-DOC"]) {
        const snapshot = monitoredOrders(history([part()], number))[0];
        legacy.prepare("INSERT INTO vk_order_monitor_snapshot VALUES (?, 'forum-auto', ?, ?)").run(destination, number, JSON.stringify(snapshot));
      }
      legacy.prepare("INSERT INTO vk_forum_active_orders VALUES (?, ?)").run(destination, JSON.stringify(["123", "OLD-DOC"]));
    }
  } finally { legacy.close(); }
  repository = new SqliteNotificationRepository(path);
  const current = parseForumAutoOrderHistory([123, 456].map((did) => ({ did, nr: "NEW-DOC", dtc: "17.10.2026 12:30:00",
    statusId: 50, status: "На комплектации", arTovs: [{ nr: "A1", k1: 10, price: 100 }] })));
  record("forum-auto", current);
  assert.equal(repository.pending(target, now), null);
  assert.equal(repository.feed().unreadCount, 0);
  repository.close(); repository = new SqliteNotificationRepository(path);
  record("forum-auto", current);
  assert.equal(repository.pending(target, now), null);
  record("armtek", history([part({ fulfillment: "cancelled" })]));
  assert.match(repository.pending(target, now).text, /ОТМЕНЕНО · Armtek/);
  repository.sent(repository.pending(target, now).id);
  record("forum-auto", { ...current, orders: current.orders.slice(0, 1) });
  assert.match(repository.pending(target, now).text, /ТРЕБУЕТ ПРОВЕРКИ · Forum Auto\nЗаказ № 456/);
  assert.deepEqual(repository.feed().entries.map(({ number, kind }) => [number, kind]), [["ORDER-1", "cancelled"], ["456", "missing"]]);
});

test("Forum Auto disappearance requires manual review and reports each last-known product without inventing a terminal status", () => {
  const repository = new SqliteNotificationRepository(":memory:");
  const missing = history([part({ quantity: 2 }), part({ article: "B2", title: "Колодки", quantity: 1, price: 300 })], "FORUM-1");
  const remaining = history([part()], "FORUM-2");
  const complete = { orders: [...missing.orders, ...remaining.orders], limited: false };
  const update = (value) => observe(repository, value, "forum-auto");
  try {
    update(complete); assert.equal(repository.pending(target, now), null);
    update(remaining);
    const message = repository.pending(target, now);
    assert.match(message.text, /ТРЕБУЕТ ПРОВЕРКИ · Forum Auto\nЗаказ № FORUM-1/);
    assert.match(message.text, /мог быть получен или отменён/); assert.match(message.text, /Последние известные товары:/);
    assert.match(message.text, /TEST A1 — Фильтр\n  2 шт\. · 200 ₽/);
    assert.match(message.text, /TEST B2 — Колодки\n  1 шт\. · 300 ₽/);
    assert.doesNotMatch(message.text, /ОТМЕНЕНО|ПОЛУЧЕНО|НОВЫЙ ЗАКАЗ|FORUM-2/);
    repository.sent(message.id); update(remaining); assert.equal(repository.pending(target, now), null);
    update(complete); assert.equal(repository.pending(target, now), null);
    update(remaining); assert.match(repository.pending(target, now).text, /ТРЕБУЕТ ПРОВЕРКИ/);
  } finally { repository.close(); }
});

test("only complete valid Forum Auto feeds establish and change the active list; other suppliers never infer disappearance", () => {
  const repository = new SqliteNotificationRepository(":memory:");
  const empty = { orders: [], limited: false };
  try {
    observe(repository, history(), "forum-auto");
    observe(repository, { ...empty, limited: true }, "forum-auto");
    assert.equal(repository.pending(target, now), null);
    assert.throws(() => repository.observe(target, [
      { supplier: "forum-auto", histories: [empty] },
      { supplier: "armtek", histories: [history([part({ quantity: NaN })])] },
    ], now));
    observe(repository, history(), "forum-auto"); assert.equal(repository.pending(target, now), null);
    observe(repository, empty, "forum-auto");
    const message = repository.pending(target, now); assert.match(message.text, /Заказ № ORDER-1/);
    repository.sent(message.id);
    for (const supplier of ["armtek", "part-kom", "rossko"]) {
      observe(repository, history(), supplier); observe(repository, empty, supplier);
    }
    assert.equal(repository.pending(target, now), null);
    const other = "77:2000000002";
    repository.observe(other, [{ supplier: "forum-auto", histories: [{ ...history(), limited: true }] }], now);
    repository.observe(other, [{ supplier: "forum-auto", histories: [empty] }], now);
    assert.equal(repository.pending(other, now), null);
  } finally { repository.close(); }
});

test("Forum Auto presence and queued disappearance survive restart without duplicate or cross-chat delivery", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aggregator-forum-monitor-"));
  const path = join(directory, "orders.sqlite");
  let repository = new SqliteNotificationRepository(path);
  t.after(async () => { repository.close(); await rm(directory, { recursive: true, force: true }); });
  observe(repository, history(), "forum-auto");
  repository.close(); repository = new SqliteNotificationRepository(path);
  observe(repository, { orders: [], limited: false }, "forum-auto");
  const original = repository.pending(target, now); assert.match(original.text, /ТРЕБУЕТ ПРОВЕРКИ/);
  repository.close(); repository = new SqliteNotificationRepository(path);
  observe(repository, { orders: [], limited: false }, "forum-auto");
  const restored = repository.pending(target, now);
  assert.equal(restored.id, original.id); assert.equal(restored.randomId, original.randomId);
  assert.equal(repository.pending("77:2000000002", now), null); assert.equal(repository.counts(target).pending, 1);
  repository.sent(restored.id);
  observe(repository, { orders: [], limited: false }, "forum-auto"); assert.equal(repository.pending(target, now), null);
});

test("upgrading a database with old Forum Auto snapshots initializes current presence without announcing historical disappearances", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aggregator-forum-upgrade-"));
  const path = join(directory, "orders.sqlite");
  let repository = new SqliteNotificationRepository(path);
  t.after(async () => { repository.close(); await rm(directory, { recursive: true, force: true }); });
  observe(repository, { orders: [...history().orders, ...history([part()], "STILL-ACTIVE").orders], limited: false }, "forum-auto");
  repository.close();
  const legacy = new DatabaseSync(path);
  try { legacy.exec("DROP TABLE vk_forum_active_orders"); } finally { legacy.close(); }
  repository = new SqliteNotificationRepository(path);
  observe(repository, history([part()], "STILL-ACTIVE"), "forum-auto");
  assert.equal(repository.pending(target, now), null);
  observe(repository, { orders: [], limited: false }, "forum-auto");
  const message = repository.pending(target, now).text;
  assert.match(message, /Заказ № STILL-ACTIVE/); assert.doesNotMatch(message, /Заказ № ORDER-1/);
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

test("legacy encrypted VK settings without quiet hours keep the agreed 23:00–07:00 pause on upgrade", async (t) => {
  const f = await fixture(t); const iv = Buffer.alloc(12, 9);
  const cipher = createCipheriv("aes-256-gcm", Buffer.alloc(32, 17), iv);
  cipher.setAAD(Buffer.from("autoservice-aggregator:vk-order-notifications:v1"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(settingsValue())), cipher.final()]);
  const path = join(f.directory, "legacy-vk.enc.json");
  await writeFile(path, JSON.stringify({ version: 1, algorithm: "aes-256-gcm", iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }));
  const restored = new EncryptedVkSettings(path, Buffer.alloc(32, 17));
  assert.deepEqual(restored.get().quietHours, { enabled: true, from: "23:00", to: "07:00" });
  assert.equal(restored.get().peerId, chats[0].id); assert.equal(restored.get().token, token);
});

test("connecting sends one welcome and leaves VK delivery disabled while the website feed is checked", async (t) => {
  const f = await fixture(t);
  const state = await f.service.connect(token, new AbortController().signal);
  assert.equal(state.peerId, chats[0].id); assert.equal(state.enabled, false);
  await f.service.runOnce(); assert.equal(f.loads.length, 1);
  assert.deepEqual(f.calls.map((call) => call.method), ["groups.getTokenPermissions", "groups.getById", "messages.getConversations", "messages.send"]);
  assert.equal(state.testMessage, "sent");
  const message = f.calls.at(-1).params.get("message");
  assert.match(message, /Агрегатор автозапчастей подключён к этой беседе/);
  assert.match(message, /новых заказах у поставщиков, отменах и получении товаров/);
  assert.match(message, /каждые 10 минут при включённых уведомлениях[\s\S]*Пауза с 23:00 до 07:00 по самарскому времени \(UTC\+4\)/);
  assert.match(message, /«Проверить сейчас» работает в любое время и не сдвигает автоматические проверки/);
  await f.service.connect(token, new AbortController().signal);
  assert.equal(f.calls.filter((call) => call.method === "messages.send").length, 1);
  assert.equal(JSON.stringify(state).includes(token), false);
  await assert.rejects(f.service.configure({ enabled: true, peerId: 2000000099 }), /Выберите/);
  f.service.disconnect();
  await f.service.connect(token, new AbortController().signal);
  assert.equal(f.calls.filter((call) => call.method === "messages.send").length, 2);
});

test("multiple or missing chats never cause an arbitrary recipient to be selected", async (t) => {
  const f = await fixture(t, { chats: [...chats, { id: 2000000002, title: "Другой чат" }] });
  const state = await f.service.connect(token, new AbortController().signal);
  assert.equal(state.peerId, null);
  assert.equal(f.calls.some((call) => call.method === "messages.send"), false);
  await assert.rejects(f.service.configure({ enabled: true }), /Выберите/);
  assert.equal((await f.service.configure({ enabled: false, peerId: 2000000002 })).peerId, 2000000002);
  assert.equal(f.calls.at(-1).params.get("peer_ids"), "2000000002");
  assert.equal(f.service.state().testMessage, "sent");
  assert.equal(f.service.state().enabled, false);
  const empty = await fixture(t, { chats: [] });
  assert.equal((await empty.service.connect(token, new AbortController().signal)).peerId, null);
  await assert.rejects(empty.service.configure({ enabled: true }), /Выберите/);
  assert.equal(empty.calls.some((call) => call.method === "messages.send"), false);
});

test("a chat missing from the conversation list binds only after the current authenticated command", async (t) => {
  let release;
  const incoming = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { chats: [], poll: async () => incoming });
  await f.service.connect(token, new AbortController().signal);
  const waiting = await f.service.beginChatPairing(new AbortController().signal);
  assert.match(waiting.pairing.command, /^\/aggregator [a-f0-9]{32}$/);
  assert.equal(Date.parse(waiting.pairing.expiresAt) - now, 300_000);
  assert.equal(JSON.stringify(waiting).includes("fixture_ephemeral_key"), false);
  assert.equal(JSON.stringify(waiting).includes(token), false);
  await assert.rejects(f.service.beginChatPairing(new AbortController().signal), /Дождитесь/);
  const command = waiting.pairing.command;
  release(pollResponse({ ts: "2", updates: [
    { ...chatMessage(command), group_id: 88 }, chatMessage(command, { peer_id: 123 }),
    chatMessage(command, { from_id: -77 }), chatMessage(command, { out: 1 }),
    chatMessage("/aggregator wrong-code"), chatMessage("Пересланное", { fwd_messages: [{ text: command }] }),
    chatMessage(`[club77|Магазин] ${command}`),
  ] }, "text/javascript; charset=utf-8"));
  const state = await waitForState(f.service, (value) => value.testMessage === "sent");
  assert.equal(state.peerId, 2000000003); assert.equal(state.chats[0].title, "Автосервис");
  assert.equal(state.enabled, false); assert.equal(state.pairing, null); assert.equal(f.loads.length, 0);
  assert.equal(f.calls.filter((call) => call.method === "messages.send").length, 1);
  assert.equal(f.calls.at(-1).params.get("peer_ids"), "2000000003");
  const reloaded = new EncryptedVkSettings(join(f.directory, "vk.enc.json"), Buffer.alloc(32, 17));
  assert.equal(reloaded.get().peerId, 2000000003);
  const resaved = await f.service.connect(token, new AbortController().signal);
  assert.equal(resaved.peerId, 2000000003); assert.equal(resaved.pairing, null);
  assert.equal(f.calls.filter((call) => call.method === "messages.send").length, 1);
});

test("Long Poll setup explains disabled events and versions and rejects unsafe upstream destinations", async (t) => {
  for (const pollSettings of [
    { is_enabled: false, api_version: "5.199", events: { message_new: 1 } },
    { is_enabled: true, api_version: "5.199", events: { message_new: 0 } },
    { is_enabled: true, api_version: "5.131", events: { message_new: 1 } },
  ]) {
    const f = await fixture(t, { chats: [], pollSettings });
    await f.service.connect(token, new AbortController().signal);
    await assert.rejects(f.service.beginChatPairing(new AbortController().signal), /Long Poll/);
    assert.equal(f.calls.some((call) => call.method === "longpoll"), false); assert.equal(f.service.state().pairing, null);
  }
  for (const server of ["https://127.0.0.1/wh77", "http://lp.vk.com/wh77", "https://lp.vk.com.evil.test/wh77", "https://user:password@lp.vk.com/wh77", "https://lp.vk.com:8443/wh77"]) {
    const f = await fixture(t, { chats: [], pollServer: { server, key: "fixture_key", ts: "1" } });
    await f.service.connect(token, new AbortController().signal);
    await assert.rejects(f.service.beginChatPairing(new AbortController().signal), /недопустимый адрес/);
    assert.equal(f.calls.some((call) => call.method === "longpoll"), false);
  }
});

test("denied access to administrative Long Poll settings still requires a real validated event server", async (t) => {
  for (const code of [7, 15]) {
    const f = await fixture(t, { apiErrors: { "groups.getLongPollSettings": code } });
    const session = await f.client.prepareChatPairing(token, 77, new AbortController().signal);
    assert.deepEqual(session, { server: "https://lp.vk.com/whp/77", key: "fixture_ephemeral_key", ts: "1" });
    assert.deepEqual(f.calls.map((call) => call.method), ["groups.getLongPollSettings", "groups.getLongPollServer"]);
    assert.equal(f.service.state().peerId, null);
    const unsafe = await fixture(t, { apiErrors: { "groups.getLongPollSettings": code },
      pollServer: { server: "https://lp.vk.com.evil.test/wh77", key: "fixture_key", ts: "1" } });
    await assert.rejects(unsafe.client.prepareChatPairing(token, 77, new AbortController().signal), /недопустимый адрес/);
    assert.equal(unsafe.calls.some((call) => call.method === "longpoll"), false);
  }
});

test("Long Poll server denials identify the failing method and code before any listener or message starts", async (t) => {
  for (const settingsDenied of [false, true]) for (const code of [7, 15]) {
    const f = await fixture(t, { apiErrors: { "groups.getLongPollServer": code,
      ...(settingsDenied ? { "groups.getLongPollSettings": 15 } : {}) } });
    f.settings.set(settingsValue({ chats: [], peerId: null }));
    await assert.rejects(f.service.beginChatPairing(new AbortController().signal), (error) => {
      assert.ok(error instanceof VkError); assert.equal(error.code, code); assert.equal(error.permanent, true);
      assert.match(error.message, new RegExp(`groups.getLongPollServer, код ${code}`));
      assert.match(error.message, /разрешения ключа/); assert.equal(error.message.includes(token), false);
      assert.equal(error.message.includes("отправлять сообщения в выбранную беседу"), false);
      return true;
    });
    assert.deepEqual(f.calls.map((call) => call.method), ["groups.getLongPollSettings", "groups.getLongPollServer"]);
    assert.equal(f.service.state().pairing, null); assert.equal(f.service.state().peerId, null); assert.equal(f.loads.length, 0);
  }
});

test("authentication, configuration, malformed codes and temporary settings failures do not bypass setup checks", async (t) => {
  for (const code of [5, 6, 27, 100, "7", 0, null]) {
    const f = await fixture(t, { apiErrors: { "groups.getLongPollSettings": code } });
    await assert.rejects(f.client.prepareChatPairing(token, 77, new AbortController().signal), (error) => {
      assert.ok(error instanceof VkError); assert.equal(error.message.includes(token), false); return true;
    });
    assert.deepEqual(f.calls.map((call) => call.method), ["groups.getLongPollSettings"]);
  }
});

test("reading chat details and actually sending messages report distinct safe permission errors", async (t) => {
  for (const code of [7, 15]) {
    const read = await fixture(t, { apiErrors: { "messages.getConversations": code } });
    await assert.rejects(read.client.connect(token, new AbortController().signal), (error) => {
      assert.equal(error.code, code); assert.match(error.message, /прочитать сведения о беседах/);
      assert.match(error.message, /messages.getConversations/); assert.equal(error.message.includes(token), false); return true;
    });
    for (const perPeer of [false, true]) {
      const send = await fixture(t, perPeer ? { send: async () => response([{ peer_id: chats[0].id, error: { code, error_msg: token } }]) }
        : { apiErrors: { "messages.send": code } });
      await assert.rejects(send.client.send(token, 77, chats[0].id, "Тест", 123, new AbortController().signal), (error) => {
        assert.equal(error.code, code); assert.equal(error.permanent, true); assert.match(error.message, /не разрешил отправку/);
        assert.match(error.message, /messages.send/); assert.equal(error.message.includes(token), false); return true;
      });
    }
  }
});

test("cancelling or disconnecting during pairing cannot bind a late incoming command", async (t) => {
  for (const action of ["cancelChatPairing", "disconnect"]) {
    let release;
    const incoming = new Promise((resolve) => { release = resolve; });
    const f = await fixture(t, { chats: [], poll: async () => incoming });
    await f.service.connect(token, new AbortController().signal);
    const waiting = await f.service.beginChatPairing(new AbortController().signal);
    f.service[action]();
    assert.equal(f.calls.at(-1).signal.aborted, true);
    release(pollResponse({ ts: "2", updates: [chatMessage(waiting.pairing.command)] }));
    await new Promise(setImmediate);
    assert.equal(f.service.state().peerId, null); assert.equal(f.service.state().pairing, null);
    assert.equal(f.service.state().configured, action !== "disconnect");
    assert.equal(f.calls.some((call) => call.method === "messages.send"), false);
  }
});

test("cancelling pairing setup aborts its API request before any listener starts", async (t) => {
  let started; const ready = new Promise((resolve) => { started = resolve; });
  const f = await fixture(t, { fetch: async (url, init) => {
    assert.ok(url.endsWith("groups.getLongPollSettings")); started();
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  } });
  f.settings.set(settingsValue({ chats: [], peerId: null }));
  const starting = f.service.beginChatPairing(new AbortController().signal);
  const rejected = assert.rejects(starting);
  await ready; f.service.cancelChatPairing(); await rejected;
  assert.equal(f.service.state().pairing, null); assert.equal(f.service.state().peerId, null);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].signal.aborted, true);
});

test("pairing expires after five minutes, aborts the poll and replaces the command on retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t, { chats: [], poll: async (_params, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }) });
  await f.service.connect(token, new AbortController().signal);
  const waiting = await f.service.beginChatPairing(new AbortController().signal);
  t.mock.timers.tick(300_000);
  const state = await waitForState(f.service, (value) => !!value.pairing?.error);
  assert.match(state.pairing.error, /Время подключения истекло/); assert.equal(state.peerId, null);
  const retry = await f.service.beginChatPairing(new AbortController().signal);
  assert.notEqual(retry.pairing.command, waiting.pairing.command);
  f.service.cancelChatPairing();
});

test("malformed Long Poll data does not choose a destination or expose raw errors", async (t) => {
  for (const payload of [{ ts: null, updates: [] }, { ts: "2", updates: "bad" }, { failed: 4 }, { ts: "2", updates: [null] }]) {
    const f = await fixture(t, { chats: [], poll: async () => pollResponse(payload) });
    await f.service.connect(token, new AbortController().signal);
    await f.service.beginChatPairing(new AbortController().signal);
    const state = await waitForState(f.service, (value) => !!value.pairing?.error);
    assert.equal(state.peerId, null); assert.equal(f.calls.some((call) => call.method === "messages.send"), false);
  }
});

test("Long Poll corrects an expired timestamp and refreshes its key without changing the pairing command", async (t) => {
  let release; const incoming = new Promise((resolve) => { release = resolve; });
  let polls = 0;
  const f = await fixture(t, { chats: [], poll: async (params) => {
    polls++;
    if (polls === 1) return pollResponse({ failed: 1, ts: "10" });
    if (polls === 2) { assert.equal(params.get("ts"), "10"); return pollResponse({ failed: 2 }); }
    return incoming;
  } });
  await f.service.connect(token, new AbortController().signal);
  const state = await f.service.beginChatPairing(new AbortController().signal);
  release(pollResponse({ ts: "11", updates: [chatMessage(state.pairing.command)] }));
  for (let attempt = 0; attempt < 3; attempt++) await new Promise((resolve) => setTimeout(resolve, 400));
  await waitForState(f.service, (value) => value.testMessage === "sent");
  assert.equal(f.calls.filter((call) => call.method === "groups.getLongPollServer").length, 2);
  assert.equal(f.calls.filter((call) => call.method === "longpoll").length, 3);
});

test("Long Poll requests time out after thirty seconds and reveal no ephemeral key", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t, { chats: [], poll: async (_params, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("fixture_ephemeral_key")), { once: true });
  }) });
  await f.service.connect(token, new AbortController().signal);
  await f.service.beginChatPairing(new AbortController().signal);
  t.mock.timers.tick(30_000);
  const state = await waitForState(f.service, (value) => !!value.pairing?.error);
  assert.equal(state.peerId, null); assert.equal(JSON.stringify(state).includes("fixture_ephemeral_key"), false);
  assert.match(state.pairing.error, /Не удалось получить сообщение/);
});

test("missing optional chat details use the authenticated peer identifier and still verify welcome delivery", async () => {
  const command = "/aggregator 0123456789abcdef0123456789abcdef";
  for (const detail of [{ response: { count: 0, items: [] } }, { response: { items: [{ peer: { id: 2000000003, type: "chat" } }] } },
    ...[7, 15, 917, 925].map((code) => ({ error: { error_code: code, error_msg: "private" } }))]) {
    const client = new VkClient(async (url) => new URL(url).hostname === "lp.vk.com"
      ? pollResponse({ ts: "2", updates: [chatMessage(command)] }) : pollResponse(detail));
    const chat = await client.waitForChat(token, 77, command, { server: "https://lp.vk.com/whp/77", key: "fixture_key", ts: "1" }, new AbortController().signal);
    assert.deepEqual(chat, { id: 2000000003, title: "ID 2000000003" });
  }
});

test("an empty chat lookup binds the command peer, persists it and reports the actual welcome result", async (t) => {
  for (const denied of [false, true]) {
    let release;
    const incoming = new Promise((resolve) => { release = resolve; });
    const f = await fixture(t, { chats: [], chatDetails: { count: 0, items: [] }, poll: async () => incoming,
      ...(denied ? { apiErrors: { "messages.send": 917 } } : {}) });
    await f.service.connect(token, new AbortController().signal);
    const waiting = await f.service.beginChatPairing(new AbortController().signal);
    assert.equal(f.service.state().peerId, null); assert.equal(f.calls.some((call) => call.method === "messages.send"), false);
    release(pollResponse({ ts: "2", updates: [chatMessage(`[club77|Магазин] ${waiting.pairing.command}`)] }));
    const state = await waitForState(f.service, (value) => value.testMessage === (denied ? "failed" : "sent"));
    assert.equal(state.peerId, 2000000003); assert.equal(state.chats[0].title, "ID 2000000003");
    assert.equal(state.enabled, false); assert.equal(state.pairing, null); assert.equal(f.loads.length, 0);
    assert.equal(f.calls.filter((call) => call.method === "messages.send").length, 1);
    assert.equal(f.calls.at(-1).params.get("peer_ids"), "2000000003");
    const reloaded = new EncryptedVkSettings(join(f.directory, "vk.enc.json"), Buffer.alloc(32, 17));
    assert.equal(reloaded.get().peerId, 2000000003);
    if (denied) { assert.match(state.error, /Тестовое сообщение не отправлено/); assert.match(state.error, /messages.send, код 917/); }
    else assert.equal(state.error, null);
  }
});

test("malformed, conflicting and explicitly left chat details never select a recipient or send a welcome", async (t) => {
  const peer = { id: 2000000003, type: "chat" };
  for (const chatDetails of [
    {}, { items: null }, { items: {} }, { items: [{ peer }, { peer }] },
    { items: [{ peer: { ...peer, id: 2000000099 } }] }, { items: [{ peer: { ...peer, type: "user" } }] },
    { items: [{ peer, chat_settings: { state: "left", title: "Чат" } }] },
    { items: [{ peer, chat_settings: { state: "kicked", title: "Чат" } }] },
  ]) {
    let release;
    const incoming = new Promise((resolve) => { release = resolve; });
    const f = await fixture(t, { chats: [], chatDetails, poll: async () => incoming });
    await f.service.connect(token, new AbortController().signal);
    const waiting = await f.service.beginChatPairing(new AbortController().signal);
    release(pollResponse({ ts: "2", updates: [chatMessage(waiting.pairing.command)] }));
    await waitForState(f.service, (value) => !!value.pairing?.error);
    assert.equal(f.service.state().peerId, null); assert.equal(f.settings.get().peerId, null);
    assert.equal(f.calls.some((call) => call.method === "messages.send"), false);
  }
});

test("authentication and temporary chat lookup failures still stop pairing without selecting a recipient", async (t) => {
  for (const code of [5, 6]) {
    let release;
    const incoming = new Promise((resolve) => { release = resolve; });
    const f = await fixture(t, { apiErrors: { "messages.getConversationsById": code }, poll: async () => incoming });
    f.settings.set(settingsValue({ chats: [], peerId: null }));
    const waiting = await f.service.beginChatPairing(new AbortController().signal);
    release(pollResponse({ ts: "2", updates: [chatMessage(waiting.pairing.command)] }));
    const state = await waitForState(f.service, (value) => !!value.pairing?.error);
    assert.equal(state.peerId, null); assert.equal(state.pairing.error.includes(token), false);
    assert.equal(f.calls.some((call) => call.method === "messages.send"), false);
  }
});

test("an aborted chat lookup cannot return a late empty response as a paired chat", async () => {
  let started; const ready = new Promise((resolve) => { started = resolve; });
  let release; const details = new Promise((resolve) => { release = resolve; });
  const command = "/aggregator 0123456789abcdef0123456789abcdef";
  const client = new VkClient(async (url) => {
    if (new URL(url).hostname === "lp.vk.com") return pollResponse({ ts: "2", updates: [chatMessage(command)] });
    assert.ok(url.endsWith("messages.getConversationsById")); started(); return details;
  });
  const controller = new AbortController();
  const waiting = client.waitForChat(token, 77, command, { server: "https://lp.vk.com/whp/77", key: "fixture_key", ts: "1" }, controller.signal);
  const rejected = assert.rejects(waiting, { name: "AbortError" });
  await ready; controller.abort(); release(response({ count: 0, items: [] })); await rejected;
});

test("a pending welcome retries while VK is paused without sending queued order updates", async (t) => {
  let unavailable = true;
  const f = await fixture(t, { send: async (params) => {
    if (unavailable) throw new Error(token);
    return response([{ peer_id: Number(params.get("peer_ids")), message_id: 0, conversation_message_id: 123 }]);
  } });
  const state = await f.service.connect(token, new AbortController().signal);
  assert.equal(state.configured, true); assert.equal(state.enabled, false); assert.equal(state.testMessage, "pending");
  assert.match(state.error, /Тестовое сообщение не отправлено/); assert.equal(state.error.includes(token), false);
  const first = f.calls.at(-1).params.get("random_id");
  observe(f.repository, history()); observe(f.repository, history([part({ fulfillment: "cancelled" })]));
  await f.service.runOnce(); assert.equal(f.calls.filter((call) => call.method === "messages.send").length, 1);
  unavailable = false; f.advance(); await f.service.runOnce();
  assert.equal(f.service.state().testMessage, "sent"); assert.equal(f.service.state().error, null);
  assert.equal(f.service.state().pending, 1); assert.equal(f.loads.length, 2);
  assert.equal(f.calls.at(-1).params.get("random_id"), first);
  assert.match(f.calls.at(-1).params.get("message"), /Агрегатор автозапчастей подключён/);
});

test("welcome delivery and its retry identifier survive restart and remain isolated by destination", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aggregator-vk-welcome-"));
  const path = join(directory, "orders.sqlite");
  let repository = new SqliteNotificationRepository(path);
  t.after(async () => { repository.close(); await rm(directory, { recursive: true, force: true }); });
  repository.ensureWelcome(target, "Тест подключения");
  const first = repository.pending(target, now, true);
  repository.retry(first.id, first.attempts, now, false);
  repository.close(); repository = new SqliteNotificationRepository(path);
  repository.ensureWelcome(target, "Другой текст не создаёт дубль");
  const restored = repository.pending(target, now + 60_000, true);
  assert.equal(restored.randomId, first.randomId); assert.equal(restored.text, "Тест подключения");
  assert.equal(repository.pending("88:2000000001", now + 60_000, true), null);
  repository.sent(restored.id);
  repository.ensureWelcome(target, "Ещё один текст");
  assert.equal(repository.welcomeState(target), "sent"); assert.equal(repository.pending(target, now, true), null);
  repository.forgetWelcome(target); repository.ensureWelcome(target, "Повторное подключение");
  assert.equal(repository.pending(target, now, true).text, "Повторное подключение");
});

test("a permanent welcome failure is visible and saving the repaired connection retries the same message", async (t) => {
  let denied = true;
  const f = await fixture(t, { send: async (params) => denied
    ? new Response(JSON.stringify({ error: { error_code: 7, error_msg: token } }), { headers: { "Content-Type": "application/json" } })
    : response([{ peer_id: Number(params.get("peer_ids")), message_id: 0, conversation_message_id: 123 }]) });
  assert.equal((await f.service.connect(token, new AbortController().signal)).testMessage, "failed");
  const first = f.calls.at(-1).params.get("random_id");
  f.advance(); await f.service.runOnce();
  assert.equal(f.calls.filter((call) => call.method === "messages.send").length, 1);
  denied = false;
  assert.equal((await f.service.connect(token, new AbortController().signal)).testMessage, "sent");
  assert.equal(f.calls.at(-1).params.get("random_id"), first); assert.equal(f.loads.length, 1);
});

test("disconnect aborts a pending welcome and cannot resurrect its destination or message", async (t) => {
  let started; const ready = new Promise((resolve) => { started = resolve; });
  const f = await fixture(t, { send: async (_params, init) => {
    started(); await new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  } });
  const connecting = f.service.connect(token, new AbortController().signal);
  const rejected = assert.rejects(connecting);
  await ready; f.service.disconnect(); await rejected;
  assert.equal(f.settings.get(), null); assert.equal(f.repository.welcomeState(target), null);
  assert.equal(f.repository.pending(target, now), null);
});

test("a digest lists several products separately inside each order and status", () => {
  const items = [
    { brand: "BOSCH", article: "0451103316", title: "Масляный фильтр", quantity: 2, price: 450 },
    { brand: "MANN", article: "C 24 015", title: "Воздушный фильтр", quantity: 1, price: 1200 },
  ];
  assert.equal(formatOrderEvents([
    { supplier: "armtek", number: "ПРИМЕР-101", kind: "new", items },
    { supplier: "part-kom", number: "ПРИМЕР-102", kind: "cancelled", items: [{ ...items[0], quantity: 1 }] },
    { supplier: "part-kom", number: "ПРИМЕР-102", kind: "received", items },
  ])[0], "Заказы: обновления\n\nНОВЫЙ ЗАКАЗ · Armtek\nЗаказ № ПРИМЕР-101"
    + "\n• BOSCH 0451103316 — Масляный фильтр\n  2 шт. · 900 ₽"
    + "\n• MANN C 24 015 — Воздушный фильтр\n  1 шт. · 1 200 ₽"
    + "\n\nОТМЕНЕНО · PartKOM\nЗаказ № ПРИМЕР-102"
    + "\n• BOSCH 0451103316 — Масляный фильтр\n  1 шт. · 450 ₽"
    + "\n\nПОЛУЧЕНО · PartKOM\nЗаказ № ПРИМЕР-102"
    + "\n• BOSCH 0451103316 — Масляный фильтр\n  2 шт. · 900 ₽"
    + "\n• MANN C 24 015 — Воздушный фильтр\n  1 шт. · 1 200 ₽");
});

test("fixed ten-minute scheduler resumes deferred reads without re-fetching already checked suppliers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
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

test("the Samara monitoring window excludes 23:00 and includes exactly 07:00 across calendar boundaries", () => {
  for (const [time, next] of [
    ["2026-10-17T06:59:59.999+04:00", "2026-10-17T07:00:00+04:00"],
    ["2026-10-17T07:00:00+04:00", "2026-10-17T07:00:00+04:00"],
    ["2026-10-17T22:59:59.999+04:00", "2026-10-17T22:59:59.999+04:00"],
    ["2026-10-17T23:00:00+04:00", "2026-10-18T07:00:00+04:00"],
    ["2026-10-18T00:00:00+04:00", "2026-10-18T07:00:00+04:00"],
    ["2026-12-31T23:59:00+04:00", "2027-01-01T07:00:00+04:00"],
  ]) assert.equal(nextOrderCheckTime(Date.parse(time)), Date.parse(next));
});

test("manual checks bypass due times without moving the automatic ten-minute cadence", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t); f.settings.set(settingsValue({ enabled: true }));
  f.service.start(); await f.service.runOnce();
  const next = f.service.state().nextCheckAt;
  f.advance(120_000); t.mock.timers.tick(120_000); await f.service.checkNow();
  assert.equal(f.loads.length, 2); assert.equal(f.service.state().nextCheckAt, next); assert.equal(f.calls.length, 0);
  f.advance(479_999); t.mock.timers.tick(479_999); assert.equal(f.loads.length, 2);
  f.advance(1); t.mock.timers.tick(1); await f.service.runOnce();
  assert.equal(f.loads.length, 3); assert.equal(Date.parse(f.service.state().nextCheckAt), Date.parse(next) + orderCheckIntervalMs);
});

test("a scheduled tick overlapping a manual check keeps its next slot and never overlaps supplier requests", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release; let loads = 0;
  const waiting = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { load: async () => ++loads === 2 ? waiting : [history()] });
  f.settings.set(settingsValue({ enabled: true })); f.service.start(); await f.service.runOnce();
  f.advance(orderCheckIntervalMs - 1_000); t.mock.timers.tick(orderCheckIntervalMs - 1_000);
  const manual = f.service.checkNow();
  await assert.rejects(f.service.checkNow(), /уже выполняется/);
  f.advance(1_000); t.mock.timers.tick(1_000); assert.equal(loads, 2);
  assert.equal(Date.parse(f.service.state().nextCheckAt), now + 2 * orderCheckIntervalMs);
  release([history()]); await manual;
  assert.equal(Date.parse(f.service.state().nextCheckAt), now + 2 * orderCheckIntervalMs);
  f.advance(); t.mock.timers.tick(orderCheckIntervalMs); await f.service.runOnce(); assert.equal(loads, 3);
});

test("manual checks send new cancellations at night with automation off and do not re-announce unchanged orders", async (t) => {
  const f = await fixture(t); f.settings.set(settingsValue()); observe(f.repository, history());
  f.setHistory(history([part({ fulfillment: "cancelled" })])); f.setTime(Date.parse("2026-10-17T23:05:00+04:00"));
  const state = await f.service.checkNow();
  assert.equal(state.enabled, false); assert.equal(state.nextCheckAt, null); assert.equal(state.checking, false);
  assert.equal(f.loads.length, 1); assert.equal(f.calls.length, 1); assert.match(f.calls[0].params.get("message"), /ОТМЕНЕНО/);
  await f.service.checkNow(); assert.equal(f.loads.length, 2); assert.equal(f.calls.length, 1);
});

test("manual retry bypasses temporary backoff but keeps the original VK delivery identifier", async (t) => {
  let unavailable = true;
  const f = await fixture(t, { send: async (params) => {
    if (unavailable) throw new Error("Fixture temporary failure");
    return response([{ peer_id: Number(params.get("peer_ids")), message_id: 0, conversation_message_id: 123 }]);
  } });
  f.settings.set(settingsValue()); observe(f.repository, history()); f.setHistory(history([part({ fulfillment: "cancelled" })]));
  await f.service.checkNow(); assert.equal(f.repository.counts(target).pending, 1);
  assert.equal(f.repository.pending(target, now), null);
  unavailable = false; await f.service.checkNow();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0].params.get("random_id"), f.calls[1].params.get("random_id"));
  assert.equal(f.repository.counts(target).pending, 0);
});

test("manual checks reject missing setup and foreground work and abort supplier IO on client cancellation", async (t) => {
  const f = await fixture(t); await assert.rejects(f.service.checkNow(), /подключите беседу/);
  f.settings.set(settingsValue()); const release = f.service.beginForegroundOperation();
  await assert.rejects(f.service.checkNow(), /Поставщики заняты/); release(); assert.equal(f.loads.length, 0);
  let started; const ready = new Promise((resolve) => { started = resolve; });
  const pending = await fixture(t, { load: async (_supplier, signal) => {
    started(); await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  pending.settings.set(settingsValue()); const controller = new AbortController();
  const checking = pending.service.checkNow(controller.signal); const rejected = assert.rejects(checking, { name: "AbortError" });
  await ready; controller.abort(); await rejected;
  assert.equal(pending.service.state().checking, false); assert.equal(pending.calls.length, 0);
});

test("quiet hours accept custom overnight and daytime pauses or round-the-clock automatic checks", async (t) => {
  const f = await fixture(t); f.settings.set(settingsValue({ enabled: true }));
  f.setTime(Date.parse("2026-10-17T22:45:00+04:00"));
  const hours = { enabled: true, from: "22:30", to: "06:15" };
  await f.service.configureSchedule(hours); await f.service.runOnce();
  assert.equal(f.loads.length, 0); assert.equal(f.service.state().nextCheckAt, "2026-10-18T02:15:00.000Z");
  assert.deepEqual(new EncryptedVkSettings(join(f.directory, "vk.enc.json"), Buffer.alloc(32, 17)).get().quietHours, hours);
  await f.service.connect(token, new AbortController().signal); assert.deepEqual(f.service.state().quietHours, hours);
  f.settings.set({ ...f.settings.get(), enabled: true });
  await f.service.configureSchedule({ ...hours, enabled: false }); await f.service.runOnce(); assert.equal(f.loads.length, 1);
  assert.equal(nextOrderCheckTime(Date.parse("2026-10-17T12:45:00+04:00"), { enabled: true, from: "12:30", to: "13:30" }), Date.parse("2026-10-17T13:30:00+04:00"));
  for (const value of [null, {}, { ...hours, from: "24:00" }, { ...hours, to: "07:60" }, { ...hours, to: "22:30" }, { ...hours, enabled: "true" }, { ...hours, extra: true }]) {
    await assert.rejects(f.service.configureSchedule(value), /Укажите время паузы/);
  }
});

test("schedule changes preserve an active automatic deadline and wake at a newly configured morning", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t); f.settings.set(settingsValue({ enabled: true }));
  f.service.start(); await f.service.runOnce(); const next = f.service.state().nextCheckAt;
  f.advance(120_000); t.mock.timers.tick(120_000);
  await f.service.configureSchedule({ enabled: true, from: "22:00", to: "06:00" });
  assert.equal(f.service.state().nextCheckAt, next);
  f.service.stop();
  const night = await fixture(t); night.setTime(Date.parse("2026-10-17T23:30:00+04:00")); night.settings.set(settingsValue({ enabled: true }));
  night.service.start(); await night.service.runOnce();
  await night.service.configureSchedule({ enabled: true, from: "22:00", to: "06:00" });
  assert.equal(night.service.state().nextCheckAt, "2026-10-18T02:00:00.000Z");
  night.advance(6.5 * 3_600_000); t.mock.timers.tick(6.5 * 3_600_000); await night.service.runOnce();
  assert.equal(night.loads.length, 1);
});

test("a server started at night wakes at 07:00 instead of retaining its startup minute offset", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const start of ["2026-10-17T23:03:00+04:00", "2026-10-18T06:55:00+04:00"]) {
    const f = await fixture(t);
    const morning = Date.parse("2026-10-18T07:00:00+04:00");
    f.setTime(Date.parse(start)); f.settings.set(settingsValue({ enabled: true }));
    f.service.start(); await f.service.runOnce();
    assert.equal(f.loads.length, 0); assert.equal(f.calls.length, 0);
    assert.equal(f.service.state().nextCheckAt, new Date(morning).toISOString());
    const wait = morning - Date.parse(start);
    f.advance(wait - 1); t.mock.timers.tick(wait - 1); assert.equal(f.loads.length, 0);
    f.advance(1); t.mock.timers.tick(1); await f.service.runOnce();
    assert.equal(f.loads.length, 1); assert.equal(f.service.state().lastCheckAt, new Date(morning).toISOString());
    assert.equal(f.service.state().nextCheckAt, new Date(morning + orderCheckIntervalMs).toISOString());
    f.advance(); t.mock.timers.tick(orderCheckIntervalMs); await f.service.runOnce(); assert.equal(f.loads.length, 2);
    f.service.stop();
  }
});

test("checks stop at 23:00, retain the baseline and outbox and deliver pending changes after 07:00", async (t) => {
  const f = await fixture(t);
  f.settings.set(settingsValue({ enabled: true }));
  f.setTime(Date.parse("2026-10-17T22:59:00+04:00")); await f.service.runOnce();
  assert.equal(f.loads.length, 1);
  observe(f.repository, history([part({ fulfillment: "cancelled" })]));
  f.setTime(Date.parse("2026-10-17T23:00:00+04:00")); await f.service.runOnce();
  f.setTime(Date.parse("2026-10-18T06:59:59+04:00")); await f.service.runOnce();
  assert.equal(f.loads.length, 1); assert.equal(f.calls.length, 0); assert.equal(f.repository.counts(target).pending, 1);
  assert.equal(f.service.state().nextCheckAt, "2026-10-18T03:00:00.000Z");
  f.setTime(Date.parse("2026-10-18T07:00:00+04:00")); await f.service.runOnce();
  assert.equal(f.loads.length, 2); assert.equal(f.calls.filter((call) => call.method === "messages.send").length, 1);
  assert.match(f.calls.at(-1).params.get("message"), /ОТМЕНЕНО · Armtek/); assert.equal(f.repository.counts(target).pending, 0);
});

test("a supplier response crossing 23:00 is saved but cannot start another supplier or send order alerts at night", async (t) => {
  const f = await fixture(t, { suppliers: ["armtek", "part-kom"], load: async () => {
    f.setTime(Date.parse("2026-10-17T23:00:00+04:00")); return [history([part({ fulfillment: "cancelled" })])];
  } });
  observe(f.repository, history()); f.settings.set(settingsValue({ enabled: true }));
  f.setTime(Date.parse("2026-10-17T22:59:59+04:00")); await f.service.runOnce();
  assert.deepEqual(f.loads, ["armtek"]); assert.equal(f.calls.length, 0);
  assert.equal(f.repository.counts(target).pending, 1); assert.equal(f.service.state().nextCheckAt, "2026-10-18T03:00:00.000Z");
});

test("enabling at night schedules morning but an explicit connection test remains available", async (t) => {
  const f = await fixture(t);
  f.setTime(Date.parse("2026-10-17T23:05:00+04:00"));
  const connected = await f.service.connect(token, new AbortController().signal);
  assert.equal(connected.testMessage, "sent");
  const state = await f.service.configure({ enabled: true }); await f.service.runOnce();
  assert.equal(state.enabled, true); assert.equal(state.nextCheckAt, "2026-10-18T03:00:00.000Z");
  assert.equal(f.loads.length, 0); assert.equal(f.calls.filter((call) => call.method === "messages.send").length, 1);
});

test("a failed Forum Auto check never triggers disappearance and the next successful empty list does", async (t) => {
  let fail = false; let orders = history();
  const f = await fixture(t, { suppliers: ["forum-auto"], load: async () => {
    if (fail) throw new SupplierTimeoutError("private"); return [orders];
  } });
  f.settings.set(settingsValue({ enabled: true })); await f.service.runOnce();
  fail = true; f.advance(); await f.service.runOnce(); assert.equal(f.calls.length, 0);
  assert.match(f.service.state().suppliers.find((item) => item.supplier === "forum-auto").error, /не ответил вовремя/);
  fail = false; orders = { orders: [], limited: false }; f.advance(); await f.service.runOnce();
  assert.equal(f.calls.length, 1); assert.match(f.calls[0].params.get("message"), /ТРЕБУЕТ ПРОВЕРКИ · Forum Auto/);
});

test("a truncated list of community dialogs never auto-selects its only visible chat", async (t) => {
  const f = await fixture(t, { fetch: async (url, init) => {
    if (url.endsWith("groups.getTokenPermissions")) return response({ mask: 4096, permissions: [] });
    if (url.endsWith("groups.getById")) return response({ groups: [{ id: 77, name: "Тестовое сообщество" }] });
    if (url.endsWith("messages.send")) return response([{ peer_id: chats[0].id, message_id: 0, conversation_message_id: 123 }]);
    assert.ok(url.endsWith("messages.getConversations"));
    const offset = Number(new URLSearchParams(init.body).get("offset"));
    return response({ count: 1001, items: Array.from({ length: 50 }, (_, index) => ({ conversation: offset === 0 && index === 0
      ? { peer: { id: chats[0].id, type: "chat" }, can_write: { allowed: true }, chat_settings: { title: chats[0].title, state: "in" } }
      : { peer: { id: offset + index + 1, type: "user" } } })) });
  } });
  const state = await f.service.connect(token, new AbortController().signal);
  assert.equal(state.chats.length, 1); assert.equal(state.peerId, null); assert.equal(state.enabled, false);
  assert.equal(f.calls.filter((call) => call.method === "messages.getConversations").length, 20);
  assert.equal((await f.service.configure({ enabled: false, peerId: chats[0].id })).peerId, chats[0].id);
});

test("failed deliveries persist and retry the same VK random_id; permanent errors pause delivery until re-enabled", async (t) => {
  let failure = true; const delivered = [];
  const f = await fixture(t, { fetch: async (url, init) => {
    assert.ok(url.endsWith("messages.send"));
    const params = new URLSearchParams(init.body);
    if (params.get("message").startsWith("Заказы:")) delivered.push(params.get("random_id"));
    if (failure) return new Response(JSON.stringify({ error: { error_code: 5, error_msg: token } }), { headers: { "Content-Type": "application/json" } });
    return response([{ peer_id: chats[0].id, message_id: 0, conversation_message_id: 123 }]);
  } });
  f.settings.set(settingsValue({ enabled: true }));
  await f.service.runOnce(); f.advance();
  f.setHistory(history([part({ fulfillment: "cancelled" })])); await f.service.runOnce();
  assert.equal(f.service.state().failed, 1); assert.equal(f.service.state().pending, 0);
  f.advance(); await f.service.runOnce(); assert.equal(delivered.length, 1);
  failure = false; await f.service.configure({ enabled: true }); await f.service.runOnce();
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
  const startPairing = (body, extraHeaders = {}) => fetch(`${url}/pairing`, { method: "POST", headers: { "Content-Type": "application/json", ...extraHeaders }, body });
  assert.equal((await startPairing("{}")).status, 400);
  assert.equal((await startPairing("{}", { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await startPairing(JSON.stringify({ peerId: 2000000001 }))).status, 400);
  const saved = await save(JSON.stringify({ token })); assert.equal(saved.status, 200);
  assert.equal(saved.headers.get("cache-control"), "no-store");
  const state = await saved.json(); assert.equal(state.enabled, false); assert.equal(JSON.stringify(state).includes(token), false);
  assert.equal((await startPairing("{}")).status, 409);
  const cancelledPairing = await fetch(`${url}/pairing`, { method: "DELETE" });
  assert.equal(cancelledPairing.status, 200); assert.equal((await cancelledPairing.json()).configured, true);
  assert.equal((await fetch(`${url}/state`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true, peerId: 2000000099 }) })).status, 400);
  assert.equal((await fetch(url, { method: "DELETE" })).status, 200);
  assert.equal((await (await fetch(url)).json()).configured, false);
});

test("manual-check and quiet-hours HTTP routes validate requests, preserve secrets and leave status reads side-effect free", async (t) => {
  let current = history(); const f = await withCancellationHistoryServer(t, "armtek", () => current);
  const post = (body, headers = {}) => fetch(`${f.origin}/api/notifications/vk/check`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
  assert.equal((await post("{}")).status, 400);
  f.settings.set(settingsValue()); observe(f.repository, current);
  for (const body of ["bad-json", "null", "[]", '{"extra":true}']) assert.equal((await post(body)).status, 400);
  assert.equal((await post("{}", { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await fetch(`${f.origin}/api/notifications/vk/check`)).status, 405);
  await (await fetch(`${f.origin}/api/notifications/vk`)).json(); assert.equal(f.loads.length, 0); assert.equal(f.calls.length, 0);
  current = history([part({ fulfillment: "cancelled" })]);
  const checked = await post("{}"); assert.equal(checked.status, 200); assert.equal(checked.headers.get("cache-control"), "no-store");
  const state = await checked.json(); assert.equal(state.enabled, false); assert.equal(JSON.stringify(state).includes(token), false);
  assert.equal(f.loads.length, 1); assert.equal(f.calls.length, 1);
  const schedule = (value, headers = {}) => fetch(`${f.origin}/api/notifications/vk/schedule`, { method: "PUT", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(value) });
  assert.equal((await schedule({ enabled: true, from: "25:00", to: "06:00" })).status, 400);
  const hours = { enabled: true, from: "22:30", to: "06:15" };
  assert.equal((await schedule(hours, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  const saved = await schedule(hours); assert.equal(saved.status, 200); assert.deepEqual((await saved.json()).quietHours, hours);
  assert.deepEqual((await (await fetch(`${f.origin}/api/notifications/vk`)).json()).quietHours, hours);
  assert.equal(f.loads.length, 1); assert.equal(f.calls.length, 1);
});

test("closing a manual-check HTTP request aborts supplier work without sending messages", async (t) => {
  let started; const ready = new Promise((resolve) => { started = resolve; }); let aborted = false;
  const f = await withCancellationHistoryServer(t, "armtek", () => history(), { load: async (_supplier, signal) => {
    started(); await new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true }));
  } });
  f.settings.set(settingsValue()); const controller = new AbortController();
  const request = fetch(`${f.origin}/api/notifications/vk/check`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: controller.signal });
  const rejected = assert.rejects(request, { name: "AbortError" }); await ready; controller.abort(); await rejected;
  await waitForState(f.service, () => aborted && !f.service.state().checking);
  assert.equal(f.calls.length, 0); assert.equal(f.repository.counts(target).pending, 0);
});
