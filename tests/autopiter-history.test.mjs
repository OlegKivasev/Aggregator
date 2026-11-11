import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AutopiterApiAdapter } from "../src/backend/suppliers/autopiter/autopiter-api-adapter.ts";
import { autopiterHistoryDate, parseAutopiterInvoiceItems, parseAutopiterInvoices } from "../src/backend/suppliers/autopiter/autopiter-history.ts";
import { parseSupplierXml } from "../src/backend/suppliers/soap-xml.ts";
import { SupplierSessionManager } from "../src/backend/session/session-manager.ts";
import { SupplierAuthError, SupplierIntegrationError, SupplierTimeoutError } from "../src/backend/errors.ts";
import { RealOrderApplicationService } from "../src/backend/application/real-order-application-service.ts";
import { createAggregatorServer } from "../src/backend/http/create-server.ts";
import { createNotificationHistorySource } from "../src/backend/notifications/create-order-notifications.ts";
import { OrderNotificationService } from "../src/backend/notifications/order-notification-service.ts";
import { EncryptedVkSettings } from "../src/backend/notifications/encrypted-vk-settings.ts";
import { SqliteNotificationRepository } from "../src/backend/notifications/sqlite-notification-repository.ts";
import { OrderCancellationService } from "../src/backend/purchasing/order-cancellation-service.ts";
import { SqliteOrderCancellationRepository } from "../src/backend/purchasing/sqlite-order-cancellation-repository.ts";

// All SOAP and VK responses are fictional. No production account is contacted.
const signal = () => new AbortController().signal;
const now = Date.parse("2026-11-12T10:00:00Z");
const xmlRows = (xml) => parseSupplierXml(`<rows>${xml}</rows>`).children;
const response = (method, xml = "") => ({ status: 200, setCookie: [], contentType: "text/xml",
  body: `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><${method}Response><${method}Result>${xml}</${method}Result></${method}Response></s:Body></s:Envelope>` });
const invoiceXml = (number = "10001", fields = "") => `<InvoiceModel><OrderNumber>${number}</OrderNumber><DateInvoice>2026-11-12T00:30:00+04:00</DateInvoice><Quantity>5</Quantity>${fields}</InvoiceModel>`;
const itemXml = (fields = {}) => {
  const values = { Id: "10", DetailUid: "fixture-offer", Number: "A1", CatalogName: "TEST", Name: "Тестовый фильтр &amp; комплект",
    OrderCount: "5", GetCount: "0", DeliveryDate: "2026-11-14T00:00:00+04:00", Price: "125.50", Region: "Тестовый склад", ...fields };
  const status = values.status ?? "677"; const statusName = values.statusName ?? "Отгружено в Самару";
  delete values.status; delete values.statusName;
  return `<OrderInformationItemModel>${Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => `<${key}>${value}</${key}>`).join("")}<Status><Id>${status}</Id><Name>${statusName}</Name></Status></OrderInformationItemModel>`;
};
const invoice = { number: "10001", date: "2026-11-12 00:30:00", quantity: 5 };
const parsed = (fields = {}) => parseAutopiterInvoiceItems(invoice, xmlRows(itemXml(fields)));
const sessions = () => {
  const manager = new SupplierSessionManager(); manager.setAutopiterCredentials({ login: "123456", password: "fixture" }, "AuthCoocies=fixture");
  manager.markAuthorized("autopiter"); return manager;
};

test("Autopiter history validates invoices, removes duplicate numbers and preserves supplier calendar dates", () => {
  const rows = xmlRows(invoiceXml("10002") + invoiceXml() + invoiceXml());
  assert.equal(parseAutopiterInvoices(rows).length, 2);
  assert.equal(parseAutopiterInvoices(rows)[0].date, "2026-11-12 00:30:00");
  assert.equal(autopiterHistoryDate("2026-11-12T00:30:00+04:00"), "2026-11-12 00:30:00");
  for (const value of ["0001-01-01T00:00:00", "2026-02-30T12:00:00Z", "2026-01-01T24:00:00", "broken"]) assert.equal(autopiterHistoryDate(value), null);
  for (const xml of [invoiceXml("0"), invoiceXml("2147483648"), invoiceXml().replace("2026-11-12T00:30:00+04:00", "broken"),
    invoiceXml().replace("<Quantity>5", "<Quantity>-1"), invoiceXml() + invoiceXml().replace("<Quantity>5", "<Quantity>4"),
    invoiceXml("10001", "<OrderNumber>10002</OrderNumber>")]) assert.throws(() => parseAutopiterInvoices(xmlRows(xml)), SupplierIntegrationError);
});

test("Autopiter maps confirmed received and cancelled quantities, and never labels shipment or branch arrival as receipt", () => {
  for (const status of ["677", "1309", "1546", "1919"]) {
    const item = parsed({ status }).items[0]; assert.equal(item.fulfillment, "in_transit"); assert.equal(item.deliveredQuantity, undefined);
  }
  const received = parsed({ status: "11", statusName: "Выдано", GetCount: "5" }).items[0];
  assert.equal(received.fulfillment, "delivered"); assert.equal(received.deliveredQuantity, 5);
  assert.equal(parsed({ status: "1858", GetCount: "5" }).items[0].fulfillment, "delivered");
  const refusal = parsed({ status: "9", statusName: "Отказ" }).items[0];
  assert.equal(refusal.fulfillment, "cancelled"); assert.equal(refusal.cancelledQuantity, 5);
  const mixed = parsed({ status: "9", GetCount: "2" }).items[0];
  assert.equal(mixed.fulfillment, "partially_cancelled"); assert.deepEqual(mixed.fulfillmentQuantities, { delivered: 2, cancelled: 3 });
  const partial = parsed({ status: "677", GetCount: "2" }).items[0];
  assert.equal(partial.fulfillment, "partial"); assert.equal(partial.deliveredQuantity, 2);
  for (const status of ["128", "1859"]) {
    const item = parsed({ status, GetCount: "5" }).items[0];
    assert.equal(item.fulfillment, "returned"); assert.equal(item.deliveredQuantity, undefined); assert.equal(item.cancelledQuantity, undefined);
  }
  assert.equal(parsed({ status: "149" }).items[0].fulfillment, "unknown");
  assert.equal(parsed({ Price: "" }).items[0].price, null);
  assert.equal(parsed({ Id: "0" }).items[0].positionId, undefined);
  assert.equal(received.expectedDate, "2026-11-14 00:00:00");
});

test("Autopiter rejects malformed historical quantities and positions without turning errors into empty history", () => {
  for (const fields of [{ Number: "" }, { OrderCount: "0" }, { OrderCount: "1.5" }, { GetCount: "6" }, { GetCount: "-1" },
    { GetCount: "" }, { status: "invalid" }, { Price: "not-a-price" }, { Id: "-1" }]) {
    assert.throws(() => parsed(fields), SupplierIntegrationError);
  }
  assert.throws(() => parseAutopiterInvoiceItems(invoice, []), SupplierIntegrationError);
  assert.throws(() => parseAutopiterInvoiceItems(invoice, xmlRows(itemXml() + itemXml())), SupplierIntegrationError);
});

test("Autopiter loads each distinct invoice once, bounds concurrent requests and uses only read methods", async (t) => {
  const manager = sessions(); const calls = []; let active = 0; let peak = 0;
  const adapter = new AutopiterApiAdapter(async (method, fields, requestSignal, cookie) => {
    calls.push({ method, fields }); assert.equal(cookie, "AuthCoocies=fixture");
    requestSignal.throwIfAborted();
    if (method === "GetInvoiceOrderByDateTime") return response(method, Array.from({ length: 12 }, (_, i) => invoiceXml(String(i + 1))).join("") + invoiceXml("1"));
    assert.equal(method, "GetFullInvoiceOrder"); active++; peak = Math.max(peak, active);
    try { await new Promise((resolve) => setTimeout(resolve, 15)); return response(method, itemXml()); } finally { active--; }
  });
  const started = performance.now();
  const result = await adapter.orderHistory("2026-11-01", "2026-11-12", signal(), manager);
  assert.equal(result.orders.length, 12); assert.equal(result.limited, false); assert.equal(peak, 4);
  assert.equal(calls.length, 13); assert.equal(new Set(calls.slice(1).map((call) => call.fields.OrderNumber)).size, 12);
  assert.deepEqual(calls[0].fields, { DateStart: "2026-11-01T00:00:00", DateFinish: "2026-11-12T23:59:59.9999999" });
  t.diagnostic(`12 invoices: 13 read requests, concurrency ${peak}, ${Math.round(performance.now() - started)} ms with 15 ms fictional detail responses`);
});

test("Autopiter bounds the returned history and does not fetch remaining invoices after the position limit", async () => {
  let details = 0;
  const adapter = new AutopiterApiAdapter(async (method) => {
    if (method === "GetInvoiceOrderByDateTime") return response(method, Array.from({ length: 20 }, (_, i) => invoiceXml(String(i + 1))).join(""));
    details++;
    return response(method, Array.from({ length: 150 }, (_, i) => itemXml({ Id: String(i + 1) })).join(""));
  });
  const result = await adapter.orderHistory("2026-11-01", "2026-11-12", signal(), sessions());
  assert.equal(result.orders.flatMap((order) => order.items).length, 500); assert.equal(result.limited, true); assert.equal(details, 4);
});

test("Autopiter history recovers expired sessions once and preserves auth, transport, empty and malformed responses", async () => {
  const manager = sessions(); manager.setAutopiterCredentials({ login: "123456", password: "fixture" });
  const calls = [];
  const adapter = new AutopiterApiAdapter(async (method) => {
    calls.push(method);
    return method === "Authorization" ? { ...response(method, "true"), setCookie: ["AuthCoocies=new; Path=/"] }
      : method === "IsAuthorization" ? response(method, "true") : response(method);
  });
  assert.deepEqual(await adapter.orderHistory("2026-11-01", "2026-11-12", signal(), manager), { orders: [], limited: false });
  assert.deepEqual(calls, ["Authorization", "IsAuthorization", "GetInvoiceOrderByDateTime"]);
  await assert.rejects(adapter.orderHistory("2026-11-01", "2026-11-12", signal(), new SupplierSessionManager()), SupplierAuthError);
  for (const failure of [new SupplierTimeoutError("fixture"), new SupplierIntegrationError("fixture")]) {
    const failing = new AutopiterApiAdapter(async () => { throw failure; });
    await assert.rejects(failing.orderHistory("2026-11-01", "2026-11-12", signal(), sessions()), (error) => error === failure);
  }
  for (const body of ["broken", '<s:Envelope xmlns:s="soap"><s:Body><GetInvoiceOrderByDateTimeResponse><GetInvoiceOrderByDateTimeResult xsi:nil="true" /></GetInvoiceOrderByDateTimeResponse></s:Body></s:Envelope>']) {
    await assert.rejects(new AutopiterApiAdapter(async () => ({ ...response("GetInvoiceOrderByDateTime"), body }))
      .orderHistory("2026-11-01", "2026-11-12", signal(), sessions()), SupplierIntegrationError);
  }
});

test("Autopiter cancels in-flight detail reads on failure and sends no queued requests after logout", async () => {
  for (const logout of [false, true]) {
    const manager = sessions(); const signals = []; const calls = [];
    const adapter = new AutopiterApiAdapter(async (method, fields, requestSignal) => {
      calls.push(method);
      if (method === "GetInvoiceOrderByDateTime") return response(method, Array.from({ length: 12 }, (_, i) => invoiceXml(String(i + 1))).join(""));
      signals.push(requestSignal);
      if (signals.length === 4) {
        if (logout) { manager.invalidateOperations("autopiter"); manager.clearAutopiterCredentials(); }
        else throw new SupplierIntegrationError("bad detail");
      }
      requestSignal.throwIfAborted();
      return await new Promise((resolve, reject) => requestSignal.addEventListener("abort", () => reject(requestSignal.reason), { once: true }));
    });
    await assert.rejects(adapter.orderHistory("2026-11-01", "2026-11-12", signal(), manager));
    assert.equal(calls.length, 5); assert.equal(signals.length, 4);
    assert.ok(signals.slice(0, 3).every((value) => value.aborted), "all outstanding requests are cancelled");
  }
});

test("Autopiter shares one expired-session recovery across concurrent history reads", async () => {
  const manager = sessions(); const calls = [];
  const adapter = new AutopiterApiAdapter(async (method, _fields, _signal, cookie) => {
    calls.push({ method, cookie });
    if (method === "GetInvoiceOrderByDateTime") return response(method, [1, 2, 3, 4].map((value) => invoiceXml(String(value))).join(""));
    if (method === "Authorization") return { ...response(method, "true"), setCookie: ["AuthCoocies=fresh; Path=/"] };
    if (method === "IsAuthorization") return response(method, "true");
    if (cookie === "AuthCoocies=fixture") return { ...response(method), status: 401 };
    assert.equal(cookie, "AuthCoocies=fresh"); return response(method, itemXml());
  });
  assert.equal((await adapter.orderHistory("2026-11-01", "2026-11-12", signal(), manager)).orders.length, 4);
  assert.equal(calls.filter((call) => call.method === "Authorization").length, 1);
  assert.equal(calls.filter((call) => call.method === "IsAuthorization").length, 1);
  assert.equal(calls.filter((call) => call.method === "GetFullInvoiceOrder" && call.cookie === "AuthCoocies=fresh").length, 4);
});

test("Autopiter history HTTP validates dates, supplies cancellation notices and retains error status codes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "autopiter-history-http-")); const previous = process.env.GARAGE_DB_PATH;
  process.env.GARAGE_DB_PATH = join(directory, "garage.sqlite");
  const queries = []; let failure = null;
  const server = createAggregatorServer({ publicDir: resolve("src/frontend"), application: {
    streamSearch: async () => {},
    supplierOrderHistory: async (query) => { queries.push(query); if (failure) throw failure; return { orders: [parsed({ status: "9" })], limited: false }; },
  } });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const path = "/api/order-history/autopiter?from=2026-11-01&to=2026-11-12";
    const result = await fetch(origin + path); assert.equal(result.status, 200); assert.equal((await result.json()).orders[0].items[0].fulfillment, "cancelled");
    assert.deepEqual(queries[0], { supplier: "autopiter", from: "2026-11-01", to: "2026-11-12" });
    const notices = await (await fetch(origin + "/api/order-cancellations")).json(); assert.equal(notices.notices[0].supplier, "autopiter");
    for (const query of ["", "?from=2026-02-30&to=2026-11-12", "?from=2026-01-01&to=2026-11-12", "?from=2026-11-01&to=2026-11-12&archive=1", "?from=2026-11-01&from=2026-11-02&to=2026-11-12"]) {
      assert.equal((await fetch(origin + "/api/order-history/autopiter" + query)).status, 400);
    }
    for (const [error, status] of [[new SupplierAuthError(), 401], [new SupplierTimeoutError(), 504], [new SupplierIntegrationError("secret upstream"), 502]]) {
      failure = error; const response = await fetch(origin + path); assert.equal(response.status, status); assert.doesNotMatch(await response.text(), /secret/);
    }
  } finally {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.GARAGE_DB_PATH; else process.env.GARAGE_DB_PATH = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Autopiter uses the shared background source and sends new orders, cancellation and receipt deltas to VK exactly once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "autopiter-history-vk-")); const path = join(directory, "orders.sqlite");
  const manager = sessions(); let timestamp = now; let fields = {}; let includeNew = false; const queries = []; const messages = [];
  const adapter = new AutopiterApiAdapter(async (method, requestFields) => response(method, method === "GetInvoiceOrderByDateTime"
    ? invoiceXml() + (includeNew ? invoiceXml("10002") : "") : itemXml(requestFields.OrderNumber === "10001" ? fields : {})));
  const application = new RealOrderApplicationService(manager, async () => assert.fail("History must not run product searches"), null, adapter);
  const repository = new SqliteNotificationRepository(path);
  const settings = new EncryptedVkSettings(join(directory, "vk.enc.json"), Buffer.alloc(32, 17));
  settings.set({ token: "vk1.a.fixture_not_a_real_token", groupId: 77, groupName: "Fixture", chats: [{ id: 2000000001, title: "Fixture chat" }], peerId: 2000000001, enabled: true });
  const cancellations = new OrderCancellationService(new SqliteOrderCancellationRepository(path));
  const source = createNotificationHistorySource({ listSupplierSessions: () => manager.getAllSessions(),
    supplierOrderHistory: async (query, signal) => { queries.push(query); return application.supplierOrderHistory(query, signal); },
  }, (supplier, history) => cancellations.observe(supplier, history));
  const service = new OrderNotificationService(settings, repository, { send: async (_token, _group, _peer, text, randomId) => { messages.push({ text, randomId }); } }, source, () => timestamp);
  try {
    await service.runOnce(); assert.equal(messages.length, 0, "first scan establishes a baseline");
    assert.deepEqual(queries[0], { supplier: "autopiter", from: "2026-08-12", to: "2026-11-12" });
    assert.equal(service.state().suppliers.find((item) => item.supplier === "autopiter").error, null);
    timestamp += 600_000; includeNew = true; fields = { status: "9", statusName: "Отказ", GetCount: "2" };
    await service.runOnce();
    assert.equal(messages.length, 1); assert.match(messages[0].text, /НОВЫЙ ЗАКАЗ · Автопитер/);
    assert.match(messages[0].text, /ОТМЕНЕНО · Автопитер/); assert.match(messages[0].text, /ПОЛУЧЕНО · Автопитер/);
    assert.match(messages[0].text, /3 шт\./); assert.match(messages[0].text, /2 шт\./);
    assert.equal(service.orderFeed().entries.length, 3); assert.ok(service.orderFeed().entries.every((event) => event.supplier === "autopiter"));
    const notice = cancellations.unread().notices[0]; assert.equal(notice.supplier, "autopiter"); assert.equal(notice.order.items[0].quantity, 3);
    timestamp += 600_000; await service.runOnce(); assert.equal(messages.length, 1);
    const afterRestart = new SqliteNotificationRepository(path);
    try { afterRestart.observe("77:2000000001", [{ supplier: "autopiter", histories: [await source.load("autopiter", signal(), timestamp).then((value) => value[0])] }], timestamp); assert.equal(afterRestart.counts("77:2000000001").pending, 0); }
    finally { afterRestart.close(); }
  } finally { await service.close(); cancellations.close(); rmSync(directory, { recursive: true, force: true }); }
});
