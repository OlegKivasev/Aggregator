import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePartKomOrderHistory } from "../src/backend/suppliers/part-kom/part-kom-order.ts";
import { listForumAutoOrderHistory, parseForumAutoOrderHistory, parseForumAutoApiResponse } from "../src/backend/suppliers/forum-auto/forum-auto-api-adapter.ts";
import { listRosskoOrderHistory, parseRosskoOrderHistory } from "../src/backend/suppliers/rossko/rossko-api-adapter.ts";
import { SupplierSessionManager } from "../src/backend/session/session-manager.ts";
import { SupplierAuthError, SupplierIntegrationError, SupplierTimeoutError } from "../src/backend/errors.ts";
import { historyDate } from "../src/backend/purchasing/order-history-values.ts";
import { armtekRequestTimeoutMs, rosskoConfig } from "../src/backend/config.ts";

const stateDirectory = mkdtempSync(join(tmpdir(), "aggregator-order-history-"));
const previousStateDirectory = process.env.STATE_DIR;
process.env.STATE_DIR = stateDirectory;
const { listArmtekOrderHistory, parseArmtekOrderHistory } = await import("../src/backend/suppliers/armtek/armtek-order.ts");
const { RealOrderApplicationService } = await import("../src/backend/application/real-order-application-service.ts");
after(() => {
  if (previousStateDirectory === undefined) delete process.env.STATE_DIR; else process.env.STATE_DIR = previousStateDirectory;
  rmSync(stateDirectory, { recursive: true, force: true });
});

test("PartKOM history groups positions by order, sorts dates and uses only validated fields", () => {
  const history = parsePartKomOrderHistory([
    { orderNumber: "OLD", orderDate: "2026-10-14 12:00:00", detailNum: "A1", maker: "TEST", quantity: 1,
      price: "100,50", stateTxt: "В работе", expectedDate: "2026-10-20", placement: "Склад" },
    { orderNumber: "NEW", orderDate: "2026-10-15 09:00:00", detailNum: "B1", quantity: 2, price: 20,
      expectedDate: "2026-02-30", stateTxt: "Заказан" },
    { orderNumber: "OLD", orderDate: "2026-10-14 12:00:00", detailNum: "A2", quantity: 1, price: 30 },
  ]);
  assert.deepEqual(history.orders.map(({ number }) => number), ["NEW", "OLD"]);
  assert.equal(history.orders[1].items.length, 2);
  assert.equal(history.orders[1].items[0].price, 100.5);
  assert.equal(history.orders[0].items[0].expectedDate, null);
  assert.equal(history.limited, false);
});

test("PartKOM history rejects malformed supplier positions", () => {
  assert.throws(() => parsePartKomOrderHistory({ orders: [] }), /history is invalid/);
  assert.throws(() => parsePartKomOrderHistory([{ orderNumber: "O1", detailNum: "A1", quantity: 0 }]), /incomplete/);
  assert.throws(() => parsePartKomOrderHistory([{ orderNumber: "O1", detailNum: "A1", quantity: 1.5 }]), /incomplete/);
});

test("PartKOM history uses issued, cancelled and stock quantities before stale descriptive status", () => {
  const row = { orderNumber: "FIXTURE-1", detailNum: "A1", quantity: 2, price: 100,
    stateTxt: "Заказ передан в службу доставки. Сопроводительные документы подготовлены." };
  const item = (fields) => parsePartKomOrderHistory([{ ...row, ...fields }]).orders[0].items[0];
  assert.equal(item({ releaseCount: 2, refusalCount: 0, storeCount: 0 }).fulfillment, "delivered");
  assert.equal(item({ releaseCount: 2 }).status, "Выдано 2 из 2 шт.");
  assert.equal(item({ releaseCount: "2", refusalCount: "0" }).fulfillment, "delivered");
  assert.equal(item({ refusalCount: 2 }).fulfillment, "cancelled");
  assert.equal(item({ releaseCount: 1, refusalCount: 1 }).fulfillment, "partially_cancelled");
  assert.equal(item({ releaseCount: 1, storeCount: 1 }).fulfillment, "partial");
  assert.match(item({ releaseCount: 1, storeCount: 1 }).status, /Выдано 1 из 2.*На складе: 1/);
  assert.equal(item({ storeCount: 2 }).fulfillment, "ready");
  assert.equal(item({ storeCount: 1 }).fulfillment, "partial");
  assert.equal(item({}).fulfillment, "in_transit");
  for (const releaseCount of [true, -1, 3, Infinity, "2 units"]) {
    assert.equal(item({ releaseCount }).fulfillment, "in_transit");
  }
  assert.equal(item({ releaseCount: 2, refusalCount: 2 }).fulfillment, "unknown");
  for (const [stateTxt, fulfillment] of [["Выдан (Доставка водителем)", "delivered"], ["Отменён", "cancelled"],
    ["На складе", "ready"], ["В работе", "processing"], ["Не выдан", "unknown"], ["Не отгружен", "unknown"],
    ["Статус не известен", "unknown"]]) assert.equal(item({ stateTxt }).fulfillment, fulfillment);
  assert.equal(item({ stateTxt: null, expectedDate: "2020-01-01" }).fulfillment, "unknown");
});

test("PartKOM distinguishes settled partial cancellations from quantities still awaiting fulfillment", () => {
  const item = (quantity, releaseCount, refusalCount) => parsePartKomOrderHistory([{
    orderNumber: "PARTIAL-CANCELLATION-FIXTURE", detailNum: "A1", quantity, releaseCount, refusalCount,
    stateTxt: "Заказ передан в службу доставки. Сопроводительные документы подготовлены.",
  }]).orders[0].items[0];
  for (const [quantity, released, refused] of [[10, 4, 6], [4, 2, 2], [20, 17, 3]]) {
    for (const stringify of [false, true]) {
      const result = item(quantity, stringify ? String(released) : released, stringify ? String(refused) : refused);
      assert.equal(result.fulfillment, "partially_cancelled");
      assert.deepEqual(result.fulfillmentQuantities, { delivered: released, cancelled: refused });
      assert.equal(result.status, `Выдано ${released} из ${quantity} шт.; Отменено ${refused} из ${quantity} шт.`);
      assert.equal(result.quantity, quantity);
    }
  }
  assert.equal(item(10, 3, 6).fulfillment, "partial");
  assert.equal(item(10, 3, 6).fulfillmentQuantities, undefined);
  assert.equal(item(10, 3, 6).cancelledQuantity, 6);
  assert.equal(item(10, 0, 6).fulfillment, "partial");
  assert.equal(item(10, 4, 0).fulfillment, "partial");
  assert.equal(item(10, 4, 7).fulfillment, "unknown");
  for (const invalid of [undefined, null, true, -1, 6.5, "6 units", Infinity]) {
    assert.equal(item(10, 4, invalid).fulfillment, "partial");
  }
});

test("PartKOM accepted and supplier handoff stages are in transit and preserve the supplier description", () => {
  const row = { orderNumber: "FIXTURE-SUPPLIER", detailNum: "A1", quantity: 2 };
  const item = (fields) => parsePartKomOrderHistory([{ ...row, ...fields }]).orders[0].items[0];
  for (const stateTxt of ["Принят в работу", "Принят в работу (Доставка водителем)",
    "Заказ передан поставщику. Поставщик подтвердил наличие товара.",
    "Заказан у поставщика (Доставка водителем)", "Заказанный артикул в пути на склад ПартКом."]) {
    assert.equal(item({ stateTxt }).fulfillment, "in_transit");
    assert.equal(item({ stateTxt, releaseCount: 0, refusalCount: 0, storeCount: 0 }).fulfillment, "in_transit");
    assert.equal(item({ stateTxt }).status, stateTxt);
    assert.equal(item({ stateTxt, releaseCount: 2 }).fulfillment, "delivered");
    assert.equal(item({ stateTxt, refusalCount: 2 }).fulfillment, "cancelled");
    assert.equal(item({ stateTxt, storeCount: 2 }).fulfillment, "ready");
  }
  assert.equal(item({ stateTxt: "Заказ не передан поставщику." }).fulfillment, "unknown");
});

test("PartKOM state zero identifies accepted orders with no description without inventing missing states", () => {
  const row = { orderNumber: "FIXTURE-INITIAL", detailNum: "A1", quantity: 1,
    state: 0, stateTxt: "", releaseCount: 0, refusalCount: 0, storeCount: 0 };
  const item = (fields = {}) => parsePartKomOrderHistory([{ ...row, ...fields }]).orders[0].items[0];
  for (const state of [0, "0"]) {
    for (const stateTxt of ["", "  ", null, undefined]) {
      assert.equal(item({ state, stateTxt }).fulfillment, "in_transit");
      assert.equal(item({ state, stateTxt }).status, "Принят в работу");
    }
  }
  for (const state of [undefined, null, false, true, "", " ", [], {}, -1, 999, "999"]) {
    assert.equal(item({ state }).fulfillment, "unknown");
    assert.equal(item({ state }).status, null);
  }
  assert.equal(item({ releaseCount: 1 }).fulfillment, "delivered");
  assert.equal(item({ refusalCount: 1 }).fulfillment, "cancelled");
  assert.equal(item({ storeCount: 1 }).fulfillment, "ready");
  assert.equal(item({ releaseCount: 1, refusalCount: 1 }).fulfillment, "unknown");
  assert.equal(item({ stateTxt: "Заказ передан в службу доставки." }).fulfillment, "in_transit");
  const unknown = item({ stateTxt: "Неизвестный этап" });
  assert.equal(unknown.fulfillment, "unknown");
  assert.equal(unknown.status, "Неизвестный этап");
});

const armtekRow = { ORDER: "0000000001", ORDER_DATE: "20261015123000", PIN: "A1", BRAND: "TEST", NAME: "Деталь",
  KWMENG: "2.000", PRICE: "100.50", CURRENCY: "RUB", STATUS: "позиция частично поставлена", DLVRD: "20261020120000" };
const forumRow = { did: 123, nr: null, dtc: "15.10.2026 12:30:00", status: "Подтвержден", mdt: "20.10.2026 00:00:00",
  arTovs: [{ nr: "A1", brand: "TEST", tovname: "Деталь", k1: 2, k3: 0, price: 100.5 }] };

test("Forum Auto keeps did as the stable order number when a document appears or changes", () => {
  for (const nr of [null, "DOC-1", "DOC-2", "123", 42, " ", "x".repeat(101)]) {
    const order = parseForumAutoOrderHistory([{ ...forumRow, nr, statusId: 50, status: "На комплектации" }]).orders[0];
    assert.equal(order.number, "123");
    assert.equal(order.documentNumber, ["DOC-1", "DOC-2"].includes(nr) ? nr : undefined);
    assert.equal(order.items[0].fulfillment, "processing");
  }
  const separate = parseForumAutoOrderHistory([forumRow, { ...forumRow, did: 456, nr: "123" }]);
  assert.deepEqual(separate.orders.map((order) => order.number), ["123", "456"]);
});
const rosskoXml = (orders, success = "true", message = "") => `<Envelope><Body><GetOrdersResponse><OrdersResult>
  <success>${success}</success>${message ? `<message>${message}</message>` : ""}<OrdersList>${orders}</OrdersList>
  </OrdersResult></GetOrdersResponse></Body></Envelope>`;
const rosskoRow = `<Order><id>123</id><created_date>15.10.2026 12:30:00</created_date><delivery_date>20.10.2026</delivery_date>
  <stock_address>Склад</stock_address><parts><part><partnumber>A1</partnumber><brand>TEST</brand><name>Деталь</name>
  <count>2</count><price>100.50</price><status>1</status></part></parts></Order>`;

test("Armtek report v2 uses actual issued quantities before stale partial or closed status", () => {
  const item = (fields) => parseArmtekOrderHistory({ DATA: [{ ...armtekRow, ...fields }] }).orders[0].items[0];
  for (const Issued of [1, "1.000"]) {
    const result = item({ KWMENG: "1", ZZKWMENG: "1.000", Issued, REJECTED: "0", REJ_MENGE: "0" });
    assert.equal(result.fulfillment, "delivered");
    assert.equal(result.status, "Получено 1 из 1 шт.");
    assert.equal(result.quantity, 1);
  }
  assert.equal(item({ STATUS: "позиция поставлена" }).fulfillment, "delivered");
  assert.equal(item({ Issued: "0", KWMENG_R: "2", STATUS: "позиция полностью поставлена" }).fulfillment, "in_transit");
  assert.equal(item({ Issued: "0", KWMENG_R: "2", STATUS: "", ORDER_STATUS: "Закрыт" }).fulfillment, "in_transit");
  assert.equal(item({ Issued: "1", STATUS: "позиция полностью поставлена" }).fulfillment, "partial");
  for (const Issued of [true, -1, 3, Infinity, "1 шт."]) {
    assert.equal(item({ Issued, STATUS: "позиция полностью поставлена" }).fulfillment, "unknown");
  }
});

test("Armtek report v2 preserves original quantities and separates issued parts from rejections and client refusals", () => {
  const item = (fields = {}) => parseArmtekOrderHistory({ DATA: [{ ...armtekRow, KWMENG: "4", ZZKWMENG: "10",
    Issued: "4", REJECTED: "6", REJ_MENGE: "0", ...fields }] }).orders[0].items[0];
  for (const fields of [{}, { REJECTED: "4", REJ_MENGE: "2" }, { REJECTED: "0", REJ_MENGE: "6" },
    { REJECTED: undefined, KWMENG_REJ: "6" }]) {
    const result = item(fields);
    assert.equal(result.fulfillment, "partially_cancelled");
    assert.deepEqual(result.fulfillmentQuantities, { delivered: 4, cancelled: 6 });
    assert.equal(result.quantity, 10);
    assert.equal(result.status, "Получено 4 из 10 шт.; Отменено 6 из 10 шт.");
  }
  assert.equal(item({ Issued: "3" }).fulfillment, "partial");
  assert.equal(item({ Issued: "3" }).fulfillmentQuantities, undefined);
  assert.equal(item({ Issued: "3" }).cancelledQuantity, 6);
  assert.equal(item({ Issued: undefined, KWMENG_R: "4" }).fulfillment, "partial");
  assert.equal(item({ Issued: "0", REJECTED: "10" }).fulfillment, "cancelled");
  assert.equal(item({ Issued: "5" }).fulfillment, "unknown");
  assert.equal(item({ REJ_MENGE: "5" }).fulfillment, "unknown");
  for (const value of [true, -1, 11, Infinity, "6 шт."]) {
    for (const field of ["REJECTED", "REJ_MENGE"]) assert.equal(item({ [field]: value }).fulfillment, "unknown");
  }
  assert.throws(() => item({ ZZKWMENG: "bad" }), SupplierIntegrationError);
});

test("supplier histories classify fulfillment without treating a closed Armtek order as receipt", () => {
  const armtek = (fields) => parseArmtekOrderHistory({ DATA: [{ ...armtekRow, ...fields }] }).orders[0].items[0].fulfillment;
  assert.equal(armtek({ STATUS: "позиция полностью поставлена" }), "delivered");
  assert.equal(armtek({ STATUS: "позиция полностью отклонена" }), "cancelled");
  assert.equal(armtek({ STATUS: "позиция частично поставлена" }), "partial");
  assert.equal(armtek({ STATUS: "позиция частично отклонена" }), "partial");
  assert.equal(armtek({ STATUS: "", ORDER_STATUS: "Закрыт", KWMENG_R: "2" }), "in_transit");
  assert.equal(armtek({ STATUS: "", ORDER_STATUS: "Закрыт" }), "unknown");
  assert.equal(armtek({ STATUS: "", KWMENG_P: "2" }), "ready");
  assert.equal(armtek({ STATUS: "", KWMENG_P: "1" }), "partial");
  assert.equal(armtek({ STATUS: "", KWMENG_REJ: "2" }), "cancelled");
  assert.equal(armtek({ STATUS: "", KWMENG_WAYIN: "2" }), "in_transit");
  assert.equal(armtek({ STATUS: "", ORDER_STATUS: "В работе" }), "in_transit");
  for (const [statusId, fulfillment] of [[0, "cancelled"], [10, "processing"], [20, "processing"], [30, "in_transit"],
    [50, "processing"], [90, "ready"], [100, "delivered"], [999, "unknown"]]) {
    assert.equal(parseForumAutoOrderHistory([{ ...forumRow, statusId,
      arTovs: [{ ...forumRow.arTovs[0], k3: 2 }] }]).orders[0].items[0].fulfillment, fulfillment);
  }
  assert.equal(parseForumAutoOrderHistory([{ ...forumRow, status: "Выдан",
    arTovs: [{ ...forumRow.arTovs[0], k3: 2 }] }]).orders[0].items[0].fulfillment, "delivered");
  const partialForum = parseForumAutoOrderHistory([{ ...forumRow, statusId: 100,
    arTovs: [{ ...forumRow.arTovs[0], k3: 1 }] }]).orders[0].items[0];
  assert.equal(partialForum.fulfillment, "partial");
  assert.equal(partialForum.status, "Выдано 1 из 2 шт.");
  assert.equal(parseForumAutoOrderHistory([{ ...forumRow, statusId: 100 }]).orders[0].items[0].fulfillment, "unknown");
  for (const [code, fulfillment] of [[0, "processing"], [1, "processing"], [2, "delivered"], [3, "ready"], [6, "ready"],
    [7, "cancelled"], [8, "cancelled"], [9, "unknown"], [31, "returned"], [32, "unknown"], [33, "unknown"],
    [34, "unknown"], [35, "unknown"], [36, "returned"], [999, "unknown"]]) {
    const xml = rosskoXml(rosskoRow.replace("<status>1</status>", `<status>${code}</status>`));
    assert.equal(parseRosskoOrderHistory(xml).orders[0].items[0].fulfillment, fulfillment);
  }
});

test("owner-confirmed Armtek work and Forum Auto confirmed statuses mean transit without overriding terminal quantities", () => {
  const armtek = (fields) => parseArmtekOrderHistory({ DATA: [{ ...armtekRow, STATUS: "В работе", ORDER_STATUS: "В работе", ...fields }] }).orders[0].items[0];
  assert.equal(armtek({}).fulfillment, "in_transit");
  assert.equal(armtek({ ORDER_STATUS: undefined }).fulfillment, "in_transit");
  assert.equal(armtek({ STATUS: "", ORDER_STATUS: "Создан" }).fulfillment, "processing");
  assert.equal(armtek({ Issued: "2" }).fulfillment, "delivered");
  assert.equal(armtek({ REJECTED: "2" }).fulfillment, "cancelled");
  for (const fields of [{}, { status: "Подтверждён" }, { statusId: 30 }, { statusId: "30" }]) {
    const result = parseForumAutoOrderHistory([{ ...forumRow, ...fields }]).orders[0].items[0];
    assert.equal(result.fulfillment, "in_transit");
    assert.equal(result.deliveredQuantity, undefined);
  }
  assert.equal(parseForumAutoOrderHistory([{ ...forumRow, statusId: 100, arTovs: [{ ...forumRow.arTovs[0], k3: 2 }] }]).orders[0].items[0].fulfillment, "delivered");
  assert.equal(parseForumAutoOrderHistory([{ ...forumRow, statusId: 0 }]).orders[0].items[0].fulfillment, "cancelled");
  assert.equal(parseForumAutoOrderHistory([{ ...forumRow, statusId: 10 }]).orders[0].items[0].fulfillment, "processing");
  assert.equal(parseForumAutoOrderHistory([{ ...forumRow, statusId: 50, status: "На комплектации" }]).orders[0].items[0].fulfillment, "processing");
});

test("Rossko portal-confirmed return code 31 and documented return code 36 stay separate from stock refusal and procurement", () => {
  const part = /<part>.*?<\/part>/s.exec(rosskoRow)[0];
  const returned = part.replace("<status>1</status>", "<status>36</status>");
  const cancelled = part.replace("<status>1</status>", "<status>7</status>").replace("A1", "B1");
  const portalReturn = part.replace("<status>1</status>", "<status>31</status>").replace("A1", "C1");
  const awaiting = part.replace("<status>1</status>", "<status>5</status>").replace("A1", "D1");
  const items = parseRosskoOrderHistory(rosskoXml(rosskoRow.replace(part, returned + cancelled + portalReturn + awaiting))).orders[0].items;
  assert.deepEqual(items.map(({ article, fulfillment, status }) => ({ article, fulfillment, status })), [
    { article: "A1", fulfillment: "returned", status: "Товар возвращён" },
    { article: "B1", fulfillment: "cancelled", status: "Нет в наличии" },
    { article: "C1", fulfillment: "returned", status: "Успешно возвращено" },
    { article: "D1", fulfillment: "processing", status: "Ожидаем поступление" },
  ]);
});

test("supplier histories normalize their documented dates, fields and ordered quantities", () => {
  const armtek = parseArmtekOrderHistory({ DATA: [armtekRow, { ...armtekRow, PIN: "B1", DLVRD: "20260230120000" }] });
  assert.equal(armtek.orders.length, 1);
  assert.equal(armtek.orders[0].items.length, 2);
  for (const history of [armtek, parseForumAutoOrderHistory([forumRow]), parseRosskoOrderHistory(rosskoXml(rosskoRow))]) {
    assert.equal(history.orders[0].date, "2026-10-15 12:30:00");
    assert.equal(history.orders[0].items[0].quantity, 2);
    assert.equal(history.orders[0].items[0].price, 100.5);
    assert.equal(history.limited, false);
  }
  assert.equal(armtek.orders[0].items[1].expectedDate, null);
  assert.equal(armtek.orders[0].items[0].warehouse, null);
  assert.equal(parseForumAutoOrderHistory([forumRow]).orders[0].number, "123");
  assert.equal(parseRosskoOrderHistory(rosskoXml(rosskoRow)).orders[0].items[0].status, "Комплектуется");
  assert.equal(parseArmtekOrderHistory({ DATA: [{ ...armtekRow, CURRENCY: undefined }] }).orders[0].items[0].price, null);
});

test("Rossko terminal status 2 matches the portal's handed-to-customer state for every order position", () => {
  const completed = rosskoRow.replace("<status>1</status>", "<status>2</status>");
  const part = completed.match(/<part>[\s\S]*<\/part>/)[0];
  const xml = rosskoXml(completed.replace("</parts>", `${part.replace("A1", "B1")}</parts>`));
  const items = parseRosskoOrderHistory(xml).orders[0].items;
  assert.equal(items.length, 2);
  assert.deepEqual(items.map(({ fulfillment }) => fulfillment), ["delivered", "delivered"]);
  assert.deepEqual(items.map(({ status }) => status), ["Передан покупателю", "Передан покупателю"]);
  const mixed = parseRosskoOrderHistory(xml.replace("<status>2</status>", "<status>1</status>")).orders[0].items;
  assert.deepEqual(mixed.map(({ fulfillment }) => fulfillment), ["processing", "delivered"]);
});

test("supplier histories reject malformed responses and never turn faults into empty orders", () => {
  for (const parse of [parseArmtekOrderHistory, parseForumAutoOrderHistory]) {
    assert.throws(() => parse(null), SupplierIntegrationError);
    assert.throws(() => parse({ error: "upstream failure" }), SupplierIntegrationError);
  }
  assert.throws(() => parseArmtekOrderHistory({ DATA: [{ ...armtekRow, KWMENG: true }] }), SupplierIntegrationError);
  assert.throws(() => parseArmtekOrderHistory({ DATA: [{ ...armtekRow, CURRENCY: "EUR" }] }), SupplierIntegrationError);
  assert.throws(() => parseForumAutoOrderHistory([{ ...forumRow, arTovs: [{ nr: "A1", k1: 0 }] }]), SupplierIntegrationError);
  assert.throws(() => parseRosskoOrderHistory(rosskoXml(rosskoRow.replace("<count>2", "<count>NaN"))), SupplierIntegrationError);
  assert.throws(() => parseRosskoOrderHistory(rosskoXml("", "false", "private supplier error")), SupplierIntegrationError);
  assert.throws(() => parseRosskoOrderHistory("<OrdersResult>"), SupplierIntegrationError);
  assert.throws(() => parseRosskoOrderHistory('<!DOCTYPE foo [<!ENTITY secret SYSTEM "file:///secret">]><root/>'), SupplierIntegrationError);
  assert.deepEqual(parseArmtekOrderHistory({ DATA: [] }), { orders: [], limited: false });
  assert.deepEqual(parseForumAutoOrderHistory([]), { orders: [], limited: false });
  assert.deepEqual(parseRosskoOrderHistory(rosskoXml("")), { orders: [], limited: false });
  assert.deepEqual(parseRosskoOrderHistory(rosskoXml("", "false", "Ничего не найдено")), { orders: [], limited: false });
});

test("new histories cap positions and mark partial output without inventing data", () => {
  const history = parseArmtekOrderHistory({ DATA: Array.from({ length: 501 }, (_, index) => ({ ...armtekRow, PIN: `A${index}` })) });
  assert.equal(history.orders[0].items.length, 500);
  assert.equal(history.limited, true);
  assert.equal(historyDate("2026-02-30"), null);
  assert.equal(historyDate("2026-10-15 24:00:00"), null);
  assert.equal(historyDate("20240229010101", "compact"), "2024-02-29 01:01:01");
});

test("Forum Auto history requests only active orders and preserves transport failures", async () => {
  const credentials = { login: "fixture", password: "fixture" };
  const signal = new AbortController().signal;
  const history = await listForumAutoOrderHistory(credentials, signal, async (method, params, receivedSignal, timeoutMs, receivedCredentials) => {
    assert.equal(method, "listorders");
    assert.equal(params.toString(), "did=0");
    assert.equal(receivedSignal, signal);
    assert.equal(receivedCredentials, credentials);
    assert.equal(timeoutMs, 30_000);
    return [forumRow];
  });
  assert.equal(history.orders[0].number, "123");
  for (const error of [new SupplierAuthError(), new SupplierTimeoutError(), new SupplierIntegrationError()]) {
    await assert.rejects(listForumAutoOrderHistory(credentials, signal, async () => { throw error; }), (caught) => caught === error);
  }
  assert.throws(() => parseForumAutoApiResponse({ status: 200, contentType: "application/json", body: '{"faultCode":10}' }, "listorders"), SupplierAuthError);
  assert.throws(() => parseForumAutoApiResponse({ status: 200, contentType: "application/json", body: "broken" }, "listorders"), SupplierIntegrationError);
});

test("Forum Auto history treats documented no-active-orders fault 26 as a complete empty list", async () => {
  for (const status of [200, 400, 422]) {
    for (const key of ["FaultCode", "faultCode", "faultcode", "code"]) {
      let calls = 0;
      const response = { status, contentType: "application/json", body: JSON.stringify({ [key]: "26", message: "private upstream text" }) };
      const result = await listForumAutoOrderHistory({ login: "fixture", password: "fixture" }, new AbortController().signal,
        async (method, params) => {
          calls++;
          assert.equal(method, "listorders");
          assert.equal(params.toString(), "did=0");
          return parseForumAutoApiResponse(response, method);
        });
      assert.deepEqual(result, { orders: [], limited: false });
      assert.equal(calls, 1, "an empty active list must not be retried");
      assert.throws(() => parseForumAutoApiResponse(response, "listorders"), SupplierIntegrationError,
        "fault 26 must remain an error outside the active-history request");
    }
  }
});

test("Forum Auto empty-history handling preserves other faults, invalid responses and cancellation", async () => {
  const credentials = { login: "fixture", password: "fixture" };
  const response = (status, payload) => ({ status, contentType: "application/json", body: JSON.stringify(payload) });
  const failures = [5, 6, 10, 11, 12, 21, 27].map((faultCode) => response(200, { faultCode }));
  failures.push(...[401, 403, 429, 500].map((status) => response(status, { faultCode: 26 })),
    response(200, { error: "private upstream text" }));
  for (const failure of failures) {
    await assert.rejects(listForumAutoOrderHistory(credentials, new AbortController().signal,
      async (method) => parseForumAutoApiResponse(failure, method)),
    (error) => error instanceof SupplierAuthError || error instanceof SupplierIntegrationError);
  }
  const controller = new AbortController();
  const reason = new Error("fixture abort");
  await assert.rejects(listForumAutoOrderHistory(credentials, controller.signal, async (method) => {
    controller.abort(reason);
    return parseForumAutoApiResponse(response(200, { faultCode: 26 }), method);
  }), (error) => error === reason);
});

test("Forum Auto history recognizes the real REST errors envelope instead of rejecting an empty active list", async () => {
  for (const FaultCode of [26, "26"]) {
    const response = { status: 200, contentType: "application/json; charset=utf-8",
      body: JSON.stringify({ errors: { FaultCode, FaultString: "private upstream text", FaultDetail: "private credentials" } }) };
    const result = await listForumAutoOrderHistory({ login: "fixture", password: "fixture" }, new AbortController().signal,
      async (method) => parseForumAutoApiResponse(response, method));
    assert.deepEqual(result, { orders: [], limited: false });
  }
});

test("Forum Auto REST errors envelopes preserve authorization, limits and real failures without exposing upstream text", () => {
  for (const FaultCode of [1, 5, 6, 10, 11, 12, 21, 26, 27]) {
    const fault = { errors: { FaultCode, FaultString: "private upstream text", FaultDetail: "private credentials" } };
    for (const payload of [fault, [fault]]) {
      const response = { status: 200, contentType: "application/json", body: JSON.stringify(payload) };
      assert.throws(() => parseForumAutoApiResponse(response, "listorders"), (error) => {
        assert.ok(error instanceof ([10, 11, 12].includes(FaultCode) ? SupplierAuthError : SupplierIntegrationError));
        if (error instanceof SupplierIntegrationError) assert.equal(error.diagnosticCode, `forum_auto_fault_${FaultCode}`);
        assert.doesNotMatch(`${error.message} ${error.publicMessage}`, /private/);
        return true;
      });
    }
  }
  const response = { status: 200, contentType: "application/json", body: '{"errors":{"FaultCode":27}}' };
  assert.deepEqual(parseForumAutoApiResponse(response, "listgoods"), []);
  assert.deepEqual(parseForumAutoApiResponse(response, "listbrands"), []);
  assert.throws(() => parseForumAutoApiResponse({ ...response, body: '{"errors":{"FaultCode":10}}' }, "clientinfo"), SupplierAuthError);
  for (const errors of [null, [], "private upstream text", { FaultCode: "invalid" }]) {
    const malformed = { ...response, body: JSON.stringify({ errors }) };
    assert.throws(() => parseForumAutoOrderHistory(parseForumAutoApiResponse(malformed, "listorders")), SupplierIntegrationError);
  }
});

test("Armtek and Rossko histories use fixed read-only methods and honor abort", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const path = new URL(url).pathname;
    if (path.endsWith("getUserVkorgList")) return Response.json({ STATUS: 200, RESP: { ARRAY: [{ VKORG: "4000" }] } });
    if (path.endsWith("getUserInfo")) return Response.json({ STATUS: 200, RESP: { STRUCTURE: { RG_TAB: [{ KUNNR: "fixture", DEFAULT: "1" }] } } });
    calls.push({ url: String(url), options });
    options.signal.throwIfAborted();
    return String(url).includes("armtek")
      ? Response.json({ STATUS: 200, RESP: { DATA: [armtekRow] } })
      : new Response(rosskoXml(rosskoRow), { headers: { "Content-Type": "text/xml" } });
  });
  const signal = new AbortController().signal;
  await listArmtekOrderHistory({ login: "fixture", password: "fixture" }, "2026-10-01", "2026-10-15", signal);
  assert.equal(new URL(calls[0].url).pathname, "/api/ws_reports/getOrderPositionsReportByDate2");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.body.get("SCRDATE"), "20261001");
  assert.equal(calls[0].options.body.get("ECRDATE"), "20261015");
  assert.equal(calls[0].options.body.get("KUNNR_RG"), "fixture");
  await listRosskoOrderHistory({ key1: "fixture<&", key2: "fixture" }, signal);
  assert.equal(calls[1].url, "https://api.rossko.ru/service/v2.1/GetOrders");
  assert.match(calls[1].options.body, /<ros:limit>500<\/ros:limit>/);
  assert.match(calls[1].options.body, /fixture&lt;&amp;/);
  assert.doesNotMatch(calls[1].options.body, /GetCheckout|createOrder/);
  const aborted = AbortSignal.abort(new Error("fixture abort"));
  await assert.rejects(listRosskoOrderHistory({ key1: "fixture", key2: "fixture" }, aborted), /fixture abort/);
});

test("history application requires supplier authorization and rejects aborted work", async () => {
  const service = new RealOrderApplicationService(new SupplierSessionManager(), async () => { throw new Error("Search must not run"); });
  for (const query of [{ supplier: "armtek", from: "2026-10-01", to: "2026-10-15" }, { supplier: "forum-auto" }, { supplier: "rossko" }]) {
    await assert.rejects(service.supplierOrderHistory(query, new AbortController().signal), SupplierAuthError);
    await assert.rejects(service.supplierOrderHistory(query, AbortSignal.abort(new Error("fixture abort"))), /fixture abort/);
  }
});

test("history body timeouts preserve typed timeout errors after headers have arrived", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const [supplier, timeout] of [["armtek", armtekRequestTimeoutMs], ["rossko", rosskoConfig.requestTimeoutMs]]) {
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    const mock = t.mock.method(globalThis, "fetch", async (url, options) => {
      const path = new URL(url).pathname;
      if (path.endsWith("getUserVkorgList")) return Response.json({ STATUS: 200, RESP: { ARRAY: [{ VKORG: "4000" }] } });
      if (path.endsWith("getUserInfo")) return Response.json({ STATUS: 200, RESP: { STRUCTURE: { RG_TAB: [{ KUNNR: "fixture", DEFAULT: "1" }] } } });
      return new Response(new ReadableStream({ start(controller) {
        options.signal.addEventListener("abort", () => controller.error(new DOMException("Aborted body", "AbortError")), { once: true });
        started();
      } }), { headers: { "Content-Type": supplier === "armtek" ? "application/json" : "text/xml" } });
    });
    const signal = new AbortController().signal;
    const result = supplier === "armtek" ? listArmtekOrderHistory({ login: "fixture", password: "fixture" }, "2026-10-01", "2026-10-15", signal)
      : listRosskoOrderHistory({ key1: "fixture", key2: "fixture" }, signal);
    const rejection = assert.rejects(result, SupplierTimeoutError);
    await ready;
    t.mock.timers.tick(timeout + 1);
    await rejection;
    mock.mock.restore();
  }
});
