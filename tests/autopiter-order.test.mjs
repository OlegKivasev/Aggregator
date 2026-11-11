import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AutopiterApiAdapter } from "../src/backend/suppliers/autopiter/autopiter-api-adapter.ts";
import { autopiterOrderFields, parseAutopiterOrderResult } from "../src/backend/suppliers/autopiter/autopiter-order.ts";
import { parseSupplierXml } from "../src/backend/suppliers/soap-xml.ts";
import { SupplierSessionManager } from "../src/backend/session/session-manager.ts";
import { attachPurchaseReference, purchaseOfferKey, samePurchaseOffer } from "../src/backend/purchasing/purchase-offer.ts";
import { CartApplicationService } from "../src/backend/purchasing/cart-application-service.ts";
import { SqliteCartRepository } from "../src/backend/purchasing/sqlite-cart-repository.ts";
import { RealOrderApplicationService } from "../src/backend/application/real-order-application-service.ts";
import { SupplierAuthError, SupplierIntegrationError, SupplierTimeoutError } from "../src/backend/errors.ts";

// Fictional fixtures. No requests to supplier accounts, including cart mutations.
const signal = () => new AbortController().signal;
const credentials = { login: "123456", password: " test-password " };
const cookie = "AuthCoocies=fixture";
const manager = () => {
  const sessions = new SupplierSessionManager(); sessions.setAutopiterCredentials(credentials, cookie);
  sessions.markAuthorized("autopiter"); return sessions;
};
const line = (index = 0) => {
  const reference = { supplier: "autopiter", detailUid: `fixture-${index}`, sellerId: "10" };
  const result = attachPurchaseReference({ supplier: "autopiter", article: "A1", brand: "TEST", title: "Тестовая деталь",
    price: 125.5, quantity: 7, warehouse: "Тестовый склад", deliveryDate: null, deliveryDateApproximate: false,
    isReturnable: true, link: "https://autopiter.ru/" }, reference);
  return { id: randomUUID(), result, reference, quantity: 2 };
};
const response = (method, content, extra = {}) => ({ status: 200, contentType: "text/xml", setCookie: [],
  body: `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><${method}Response xmlns="http://www.autopiter.ru/"><${method}Result>${content}</${method}Result></${method}Response></s:Body></s:Envelope>`, ...extra });
const entry = (item, changes = {}) => `<ResponseCodeItemCart><Code>${(changes.codes ?? ["0"]).map((code) => `<ResponseCode>${code}</ResponseCode>`).join("")}</Code><Item><DetailUid>${changes.uid ?? item.reference.detailUid}</DetailUid><SalePrice>${changes.price ?? item.result.price}</SalePrice><Quantity>${changes.quantity ?? item.quantity}</Quantity><DeliveryDate>2026-11-14T00:00:00+03:00</DeliveryDate></Item></ResponseCodeItemCart>`;
const payload = (items = "", number = "10001") => `<MakeOrderByItemsResult xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><Items>${items}</Items>${number === null ? '<OrderNumber xsi:nil="true" />' : `<OrderNumber>${number}</OrderNumber>`}</MakeOrderByItemsResult>`;
const parse = (xml, lines) => parseAutopiterOrderResult(parseSupplierXml(xml), xml, lines);
const orderResponse = (items, number = "10001") => response("MakeOrderByItems", "", {
  body: `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><MakeOrderByItemsResponse>${payload(items, number)}</MakeOrderByItemsResponse></s:Body></s:Envelope>` });

test("Autopiter binds refresh and cart identity to the exact detail and seller while keeping identifiers private", () => {
  const first = line(); const second = line(1);
  assert.equal(samePurchaseOffer(first, first), true);
  assert.equal(samePurchaseOffer(first, second), false);
  assert.equal(samePurchaseOffer(first, { ...first, reference: { ...first.reference, sellerId: "11" } }), false);
  assert.notEqual(purchaseOfferKey(first.result, first.reference), purchaseOfferKey(second.result, second.reference));
  assert.equal(JSON.stringify(first.result).includes("detailUid"), false);
  assert.deepEqual(autopiterOrderFields([first, second]).Items.ItemAddCartModel, [first, second].map((item) => ({
    DetailUid: item.reference.detailUid, Comment: "", SalePrice: "125.5", Quantity: "2" })));
  for (const lines of [[], [first, first], [{ ...first, quantity: 8 }], [{ ...first, quantity: 1.5 }],
    [{ ...first, result: { ...first.result, price: NaN } }], [{ ...first, reference: { ...first.reference, detailUid: "" } }]]) {
    assert.throws(() => autopiterOrderFields(lines), SupplierIntegrationError);
  }
});

test("Autopiter requires an invoice, maps reordered confirmations by detail and retains partial quantities", () => {
  const lines = [line(), line(1)];
  const result = parse(payload(entry(lines[1]) + entry(lines[0], { quantity: 1 })), lines);
  assert.deepEqual(result.confirmed.map((item) => [item.id, item.acceptedQuantity, item.orderIds]), [
    [lines[0].id, 1, ["10001"]], [lines[1].id, 2, ["10001"]],
  ]);
  assert.equal(result.confirmed[0].autopiterOrders[0].deliveryAt, "2026-11-14T00:00:00+03:00");
  // Items is optional in WSDL; a positive invoice number itself confirms the submitted batch.
  assert.equal(parse(payload().replace("<Items></Items>", ""), lines).confirmed.length, 2);
  assert.throws(() => parse(payload(entry(lines[0]), null), lines), SupplierIntegrationError);
});

test("Autopiter treats an explicit refusal without an invoice as rejection of the whole batch", () => {
  const lines = [line(), line(1)];
  for (const code of ["1", "2", "3", "4", "5", "7", "8", "9", "11"]) {
    const result = parse(payload(entry(lines[0], { codes: [code], price: 200, quantity: 0 }), null), lines);
    assert.equal(result.confirmed.length, 0); assert.equal(result.rejected.length, 2);
    assert.ok(result.rejected.every((item) => item.message.length > 0));
  }
});

test("Autopiter never guesses success or safe refusal from missing, foreign, duplicate or contradictory replies", () => {
  const lines = [line(), line(1)];
  for (const xml of [payload("", null), payload("", ""), payload("", "0"), payload("", "2147483648"),
    payload(entry(lines[0])), payload(entry(lines[0]) + entry(lines[0])),
    payload(entry(lines[0], { uid: "foreign" }) + entry(lines[1])),
    payload(entry(lines[0], { price: 126 }) + entry(lines[1])),
    payload(entry(lines[0], { quantity: 3 }) + entry(lines[1])),
    payload(entry(lines[0]).replace("<SalePrice>", "<SellerId>11</SellerId><SalePrice>") + entry(lines[1])),
    payload(entry(lines[0], { codes: ["4"] }) + entry(lines[1])),
    payload(entry(lines[0], { codes: ["6"] }), null),
    payload(entry(lines[0], { codes: ["12"] }), null),
    payload(entry(lines[0], { codes: [] }), null),
    payload().replace("</OrderNumber>", "</OrderNumber><OrderNumber>10002</OrderNumber>")]) {
    assert.throws(() => parse(xml, lines), SupplierIntegrationError, xml);
  }
});

test("Autopiter recovers expired authorization before sending one batch and preserves rotated cookies", async () => {
  const sessions = manager(); const lines = [line(), line(1)]; const methods = [];
  let checks = 0;
  const adapter = new AutopiterApiAdapter(async (method, fields, receivedSignal, receivedCookie) => {
    receivedSignal.throwIfAborted(); methods.push(method);
    if (method === "Authorization") return response(method, "true", { setCookie: ["AuthCoocies=renewed; Path=/"] });
    if (method === "IsAuthorization") return response(method, ++checks === 1 ? "false" : "true");
    assert.equal(method, "MakeOrderByItems"); assert.equal(receivedCookie, "AuthCoocies=renewed");
    assert.equal(fields.Items.ItemAddCartModel.length, 2);
    return orderResponse(lines.map((item) => entry(item)).join(""));
  });
  const submit = await adapter.prepareOrder(lines, signal(), sessions);
  assert.equal(methods.includes("MakeOrderByItems"), false);
  assert.equal((await submit("fixture-attempt", signal())).confirmed.length, 2);
  await assert.rejects(submit("fixture-attempt", signal()), /already been submitted/);
  assert.deepEqual(methods, ["IsAuthorization", "Authorization", "IsAuthorization", "MakeOrderByItems"]);
});

test("Autopiter never reauthorizes or resends after a mutation returns timeout, auth failure or malformed response", async () => {
  const nilResult = orderResponse("");
  nilResult.body = nilResult.body.replace('<MakeOrderByItemsResult xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">', '<MakeOrderByItemsResult xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:nil="true">');
  for (const failure of [new SupplierTimeoutError("test timeout"), response("MakeOrderByItems", "", { status: 401 }),
    response("MakeOrderByItems", "", { body: "broken" }), nilResult]) {
    const calls = [];
    const adapter = new AutopiterApiAdapter(async (method) => {
      calls.push(method);
      if (method === "IsAuthorization") return response(method, "true");
      if (failure instanceof Error) throw failure;
      return failure;
    });
    const submit = await adapter.prepareOrder([line()], signal(), manager());
    await assert.rejects(submit("attempt", signal()));
    assert.deepEqual(calls, ["IsAuthorization", "MakeOrderByItems"]);
  }
});

test("Autopiter aborts orders on logout and refuses a different session between preparation and submission", async () => {
  const sessions = manager(); const calls = [];
  const adapter = new AutopiterApiAdapter(async (method, _fields, receivedSignal) => {
    calls.push(method);
    if (method === "IsAuthorization") return response(method, "true");
    sessions.invalidateOperations("autopiter"); sessions.clearAutopiterCredentials();
    assert.equal(receivedSignal.aborted, true);
    return orderResponse("");
  });
  let submit = await adapter.prepareOrder([line()], signal(), sessions);
  sessions.invalidateOperations("autopiter");
  await assert.rejects(submit("attempt", signal()), SupplierAuthError);
  assert.deepEqual(calls, ["IsAuthorization"]);
  submit = await adapter.prepareOrder([line()], signal(), sessions);
  await assert.rejects(submit("attempt", signal()));
  assert.deepEqual(calls, ["IsAuthorization", "IsAuthorization", "MakeOrderByItems"]);
});

for (const count of [1, 50, 500]) test(`Autopiter cart refresh deduplicates ${count} rows and submits a single supplier batch`, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "autopiter-order-"));
  const sessions = manager(); const lines = Array.from({ length: count }, (_, index) => line(index));
  const methods = []; let searches = 0;
  const adapter = new AutopiterApiAdapter(async (method, fields) => {
    methods.push(method);
    if (method === "FindCatalog") return response(method, "<SearchCatalogModel><Number>A1</Number><ArticleId>101</ArticleId><CatalogName>TEST</CatalogName></SearchCatalogModel>");
    if (method === "GetPriceId") return response(method, lines.map((item) => `<PriceSearchModel><DetailUid>${item.reference.detailUid}</DetailUid><SellerId>10</SellerId><Number>A1</Number><CatalogName>TEST</CatalogName><Name>Тестовая деталь</Name><SalePrice>125.5</SalePrice><NumberOfAvailable>7</NumberOfAvailable><Region>Тестовый склад</Region><TypeRefusal>1</TypeRefusal><CurrencyName>RUB</CurrencyName></PriceSearchModel>`).join(""));
    if (method === "IsAuthorization") return response(method, "true");
    assert.equal(fields.Items.ItemAddCartModel.length, count);
    return orderResponse(lines.map((item) => entry(item)).join(""));
  });
  const gateway = new RealOrderApplicationService(sessions, async (query, emit, searchSignal) => {
    searches++;
    await adapter.search(query, { signal: searchSignal, timeoutMs: 1000 }, (result) => emit({ type: "result", result }), sessions);
    emit({ type: "supplier_status", supplier: "autopiter", status: "completed" });
  }, null, adapter);
  const cart = new CartApplicationService(new SqliteCartRepository(join(directory, "cart.sqlite")), async () => [], gateway);
  try {
    lines.forEach((item) => assert.equal(cart.registerOffer(item.id, item.result), true));
    cart.mutate("add", { revision: 0, offers: lines.map((item) => ({ offerId: item.id, quantity: item.quantity })) });
    assert.equal(JSON.stringify(cart.view()).includes("detailUid"), false);
    const started = performance.now();
    const fresh = await cart.refreshForOrder(1, "autopiter", signal());
    assert.equal(searches, 1); assert.ok(fresh.items.every((item) => !item.unavailable));
    assert.deepEqual(await cart.orderChoices(fresh.revision, "autopiter", signal()), {});
    const result = await cart.order(fresh.revision, "autopiter", fresh.items.map((item) => item.id), {}, signal());
    assert.equal(result.cart.count, 0); assert.equal(result.results[0].result.confirmed.length, count);
    assert.deepEqual(methods, ["FindCatalog", "GetPriceId", "IsAuthorization", "MakeOrderByItems"]);
    t.diagnostic(`${count} rows: four SOAP calls (catalog, prices, session, order); ${Math.round(performance.now() - started)} ms locally with fictional supplier`);
  } finally { cart.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("Autopiter persists uncertain batch attempts and prevents duplicate orders after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "autopiter-uncertain-")); const path = join(directory, "cart.sqlite");
  const item = line(); let submissions = 0;
  const gateway = { refresh: async (lines) => lines, choices: async () => ({}), prepare: async () => async () => {
    submissions++; throw new SupplierTimeoutError("lost reply");
  } };
  let cart = new CartApplicationService(new SqliteCartRepository(path), async () => [], gateway);
  try {
    cart.registerOffer(item.id, item.result); cart.mutate("add", { revision: 0, offerId: item.id, quantity: 2 });
    const fresh = await cart.refreshForOrder(1, "autopiter", signal());
    const result = await cart.order(fresh.revision, "autopiter", fresh.items.map((entry) => entry.id), {}, signal());
    assert.equal(result.results[0].status, "uncertain"); assert.equal(result.cart.count, 2);
    cart.close(); cart = new CartApplicationService(new SqliteCartRepository(path), async () => [], gateway);
    assert.equal(cart.view().pendingIds.length, 1);
    await assert.rejects(cart.order(cart.view().revision, "autopiter", cart.view().items.map((entry) => entry.id), {}, signal()), /сверить/);
    assert.equal(submissions, 1);
  } finally { cart.close(); rmSync(directory, { recursive: true, force: true }); }
});
