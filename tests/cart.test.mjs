import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CartApplicationService } from "../src/backend/purchasing/cart-application-service.ts";
import { SqliteCartRepository } from "../src/backend/purchasing/sqlite-cart-repository.ts";
import { attachPurchaseReference, getPurchaseReference } from "../src/backend/purchasing/purchase-offer.ts";
import { buildPartKomTestOrderForm, parsePartKomTestOrderResponse, testPartKomOrder } from "../src/backend/suppliers/part-kom/part-kom-test-order.ts";
import { buildArmtekTestOrderParams, parseArmtekTestOrderResponse, testArmtekOrder } from "../src/backend/suppliers/armtek/armtek-test-order.ts";
import { parsePartKomApiResults } from "../src/backend/suppliers/part-kom/part-kom-api-adapter.ts";
import { testPurchaseOrder } from "../src/backend/application/test-order-application-service.ts";
import { SupplierSessionManager } from "../src/backend/session/session-manager.ts";
import { SupplierAuthError, SupplierIntegrationError } from "../src/backend/errors.ts";

// All offers, credentials and upstream responses in this file are fictional fixtures.
const reference = (supplier = "armtek") => supplier === "armtek" ? { supplier, keyzak: "TEST01" } : { supplier, makerId: "101", providerId: "202" };
const result = (supplier = "armtek", quantity = 4) => attachPurchaseReference({ supplier, brand: "TEST", article: "A1", title: "Тестовая деталь",
  price: 100, quantity, warehouse: "Тестовый склад", deliveryDate: null, deliveryDateApproximate: false, link: "https://etp.armtek.ru/" }, reference(supplier));
const line = (supplier = "armtek") => ({ id: randomUUID(), result: result(supplier), quantity: 2, reference: reference(supplier) });
const response = (body, status = 200) => ({ status, body: JSON.stringify(body), contentType: "application/json", setCookie: [] });
const acceptedResponse = (item) => ({ ITEMS: [{ PIN: "A1", BRAND: "TEST", KEYZAK: "TEST01", KWMENG: "2", REMAIN: "0",
  RESULT: [{ KEYZAK: "TEST01", KWMENG: "2", PRICE: "100" }], ...item }] });

const withCart = async (check, testOrder = async () => []) => {
  const directory = mkdtempSync(join(tmpdir(), "aggregator-cart-"));
  const path = join(directory, "cart.sqlite");
  let service = new CartApplicationService(new SqliteCartRepository(path), testOrder);
  try { await check(service, () => { service.close(); service = new CartApplicationService(new SqliteCartRepository(path), testOrder); return service; }); }
  finally { service.close(); rmSync(directory, { recursive: true, force: true }); }
};

test("cart limits integer quantities, combines exact offers and conceals supplier references", async () => {
  await withCart((cart) => {
    const id = randomUUID();
    cart.registerOffer(id, result());
    for (const quantity of [0, -1, 1.5, 5, "2", NaN, Infinity]) assert.throws(() => cart.mutate("add", { offerId: id, quantity, revision: 0 }));
    const first = cart.mutate("add", { offerId: id, quantity: 2, revision: 0 });
    const secondId = randomUUID();
    cart.registerOffer(secondId, result());
    const next = cart.mutate("add", { offerId: secondId, quantity: 2, revision: first.revision });
    assert.equal(next.items.length, 1);
    assert.equal(next.count, 4);
    assert.equal(next.total, 400);
    assert.ok(!JSON.stringify(next).includes("TEST01"));
    assert.throws(() => cart.mutate("add", { offerId: id, quantity: 1, revision: next.revision }), /от 1 до 4/);
    assert.throws(() => cart.mutate("remove", { id: first.items[0].id, revision: 0 }), /Корзина изменилась/);
    const updated = cart.mutate("update", { id: first.items[0].id, quantity: 3, revision: next.revision });
    assert.equal(updated.count, 3);
    assert.equal(cart.mutate("remove", { id: first.items[0].id, revision: updated.revision }).count, 0);
  });
});

test("cart persists across restart while transient search offers expire", async () => {
  await withCart((cart, reopen) => {
    const id = randomUUID();
    cart.registerOffer(id, result("part-kom"));
    cart.mutate("add", { offerId: id, quantity: 1, revision: 0 });
    const restored = reopen();
    assert.equal(restored.view().count, 1);
    assert.throws(() => restored.mutate("add", { offerId: id, quantity: 1, revision: 1 }), /устарело/);
  });
});

test("cart refuses missing routing, zero/unknown stock and keeps warehouses separate", async () => {
  await withCart((cart) => {
    for (const quantity of [null, undefined, 0, 0.5]) {
      const id = randomUUID();
      const offer = result();
      offer.quantity = quantity;
      cart.registerOffer(id, offer);
      assert.throws(() => cart.mutate("add", { offerId: id, quantity: 1, revision: 0 }), /устарело/);
    }
    const missingId = randomUUID();
    const missing = structuredClone(result());
    cart.registerOffer(missingId, missing);
    assert.throws(() => cart.mutate("add", { offerId: missingId, quantity: 1, revision: 0 }), /не поддерживает/);
    const id = randomUUID();
    cart.registerOffer(id, result());
    cart.mutate("add", { offerId: id, quantity: 1, revision: 0 });
    const otherId = randomUUID();
    const other = attachPurchaseReference(result(), { supplier: "armtek", keyzak: "TEST02" });
    cart.registerOffer(otherId, other);
    assert.equal(cart.mutate("add", { offerId: otherId, quantity: 1, revision: 1 }).items.length, 2);
  });
});

test("cart freezes mutations during testing, forwards cancellation and does not clear goods", async () => {
  let started;
  const gate = new Promise((resolve) => { started = resolve; });
  await withCart(async (cart) => {
    const id = randomUUID();
    cart.registerOffer(id, result());
    cart.mutate("add", { offerId: id, quantity: 1, revision: 0 });
    const controller = new AbortController();
    const checking = cart.test(1, controller.signal);
    await gate;
    assert.throws(() => cart.mutate("remove", { id: cart.view().items[0].id, revision: 1 }), /Дождитесь/);
    assert.throws(() => cart.clear("all", 1), /Дождитесь/);
    await assert.rejects(cart.test(1, controller.signal), /уже проверяется/);
    controller.abort(new Error("Cancelled fixture"));
    await assert.rejects(checking, /Cancelled fixture/);
    assert.equal(cart.view().count, 1);
    assert.equal(cart.view().testing, false);
  }, async (_lines, signal) => { started(); return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); });
});

test("cart atomically clears only the requested supplier and rejects invalid or stale scopes", async () => {
  await withCart((cart, reopen) => {
    for (const supplier of ["armtek", "part-kom"]) {
      const id = randomUUID();
      cart.registerOffer(id, result(supplier));
      cart.mutate("add", { offerId: id, quantity: 2, revision: cart.view().revision });
    }
    for (const scope of [undefined, null, "stparts", [], {}]) assert.throws(() => cart.clear(scope, 2), /Выберите вкладку/);
    assert.throws(() => cart.clear("all", 1), /Корзина изменилась/);
    assert.equal(cart.view().count, 4);
    const cleared = cart.clear("part-kom", 2);
    assert.equal(cleared.revision, 3);
    assert.equal(cleared.count, 2);
    assert.ok(cleared.items.every((item) => item.result.supplier === "armtek"));
    assert.equal(cart.clear("part-kom", 3).revision, 3);
    const restored = reopen();
    assert.equal(restored.view().count, 2);
    assert.equal(restored.clear("all", 3).count, 0);
    assert.equal(restored.view().revision, 4);
  });
});

test("cart tests only the selected supplier while keeping all-mode and real-order protection", async () => {
  const calls = [];
  await withCart(async (cart) => {
    for (const supplier of ["armtek", "part-kom"]) {
      const id = randomUUID();
      cart.registerOffer(id, result(supplier));
      cart.mutate("add", { offerId: id, quantity: 1, revision: cart.view().revision });
    }
    const controller = new AbortController();
    const selected = await cart.test(2, controller.signal, "armtek");
    assert.equal(selected.testOnly, true);
    assert.equal(selected.supplier, "armtek");
    assert.equal(selected.results.length, 1);
    assert.deepEqual(calls[0], ["armtek"]);
    assert.equal((await cart.test(2, controller.signal)).supplier, "all");
    assert.deepEqual(calls[1], ["armtek", "part-kom"]);
    await assert.rejects(cart.test(2, controller.signal, "stparts"), /Выберите вкладку/);
    cart.clear("part-kom", 2);
    await assert.rejects(cart.test(3, controller.signal, "part-kom"), /выбранную вкладку/);
    assert.equal(cart.view().count, 1);
  }, async (lines) => {
    calls.push(lines.map((line) => line.reference.supplier));
    return lines.map((line) => ({ id: line.id, status: "accepted", acceptedQuantity: line.quantity, message: "fixture" }));
  });
});

test("PartKOM normalization retains actual ordering identifiers without altering search JSON", () => {
  const [offer] = parsePartKomApiResults([{ number: "A1", maker: "TEST", makerId: 101, providerId: 202,
    description: "Тест", price: 100, quantity: 4 }], "A1");
  assert.deepEqual(getPurchaseReference(offer), reference("part-kom"));
  assert.ok(!JSON.stringify(offer).includes("providerId"));
  const [invalid] = parsePartKomApiResults([{ number: "A1", maker: "TEST", makerId: 101, providerId: "unknown",
    description: "Тест", price: 100, quantity: 4 }], "A1");
  assert.equal(getPurchaseReference(invalid), null);
});

test("PartKOM sends only multipart test orders with exact warehouse and no reordering", async () => {
  const item = line("part-kom");
  const form = buildPartKomTestOrderForm([item]);
  assert.equal(form.get("flagTest"), "1");
  assert.equal(form.get("orderItems[0][providerId]"), "202");
  assert.equal(form.get("orderItems[0][reorderAgreement]"), "0");
  let calls = 0;
  const checked = await testPartKomOrder({ login: "fixture", password: "fixture-secret" }, [item], new AbortController().signal, async (url, options) => {
    calls++;
    assert.equal(url.href, "https://ws.part-kom.ru/v4/basket/order");
    assert.equal(options.method, "POST");
    assert.match(options.headers["Content-Type"], /^multipart\/form-data; boundary=/);
    const decoded = await new Response(options.body, { headers: { "Content-Type": options.headers["Content-Type"] } }).formData();
    assert.equal(decoded.get("flagTest"), "1");
    assert.equal(decoded.get("returnOnSuccess"), "1");
    assert.equal(decoded.get("orderItems[0][quantity]"), "2");
    return response({ undocumented: "fixture" });
  });
  assert.equal(calls, 1);
  assert.equal(checked[0].status, "unconfirmed");
  assert.throws(() => parsePartKomTestOrderResponse(response({}, 401), [item]), SupplierAuthError);
  assert.throws(() => parsePartKomTestOrderResponse({ ...response({}), body: "invalid" }, [item]), SupplierIntegrationError);
  assert.throws(() => parsePartKomTestOrderResponse({ ...response({}), body: "<html>fixture</html>", contentType: "text/html" }, [item]), SupplierIntegrationError);
  assert.equal(parsePartKomTestOrderResponse({ ...response({}), contentType: "text/plain" }, [item])[0].status, "unconfirmed");
});

test("Armtek sends createTestOrder using KUNRG, exact KEYZAK, quantity and price ceiling", async () => {
  const item = line();
  const config = { vkorg: "TEST", kunnrRg: "fixture-buyer", kunnrZa: "fixture-address", incoterms: "0", vbeln: "fixture-contract" };
  const params = buildArmtekTestOrderParams(config, [item]);
  assert.equal(params.get("KUNRG"), "fixture-buyer");
  assert.equal(params.get("KUNNR_RG"), null);
  assert.equal(params.get("ITEMS[0][KEYZAK]"), "TEST01");
  assert.equal(params.get("ITEMS[0][PRICEMAX]"), "100");
  let calls = 0;
  const checked = await testArmtekOrder({ login: "fixture", password: "fixture-secret" }, [item], new AbortController().signal, {
    resolveConfig: async () => config,
    request: async (path, _credentials, options) => {
      calls++;
      assert.equal(path, "ws_order/createTestOrder");
      assert.equal(options.method, "POST");
      assert.equal(options.params.get("ITEMS[0][KWMENG]"), "2");
      return acceptedResponse();
    },
  });
  assert.equal(calls, 1);
  assert.equal(checked[0].status, "accepted");
});

test("Armtek validates full, partial, refused, missing, mismatched and malformed allocations", () => {
  const item = line();
  const parse = (payload) => parseArmtekTestOrderResponse(payload, [item])[0];
  assert.equal(parse(acceptedResponse()).acceptedQuantity, 2);
  const partial = parse(acceptedResponse({ REMAIN: "1", RESULT: [{ KEYZAK: "TEST01", KWMENG: "1", PRICE: "100" }] }));
  assert.equal(partial.status, "rejected");
  assert.equal(partial.acceptedQuantity, 1);
  assert.equal(parse(acceptedResponse({ ERROR: "X" })).status, "rejected");
  for (const fields of [{ REMAIN: undefined }, { PIN: "OTHER" }, { KEYZAK: "OTHER" }, { KWMENG: "3" },
    { RESULT: [{ KEYZAK: "OTHER", KWMENG: "2", PRICE: "100" }] }, { RESULT: [{ KEYZAK: "TEST01", KWMENG: "2", PRICE: "101" }] },
    { RESULT: [{ KEYZAK: "TEST01", KWMENG: "2", PRICE: "NaN" }] }, { RESULT: [] }]) {
    assert.equal(parse(acceptedResponse(fields)).status, "unconfirmed");
  }
  assert.throws(() => parse({ ITEMS: null }), SupplierIntegrationError);
});

test("test orders isolate supplier errors, require credentials and follow session invalidation", async () => {
  const manager = new SupplierSessionManager();
  const lines = [line(), line("part-kom")];
  let called = 0;
  const requests = {
    armtek: async () => { called++; return [{ id: lines[0].id, status: "accepted", acceptedQuantity: 2, message: "fixture" }]; },
    partKom: async () => { called++; throw new SupplierIntegrationError("fixture upstream password=secret"); },
  };
  const missing = await testPurchaseOrder(manager, lines, new AbortController().signal, requests);
  assert.equal(called, 0);
  assert.ok(missing.every((item) => item.status === "unconfirmed"));
  manager.setArmtekCredentials({ login: "fixture", password: "fixture-secret" });
  manager.setPartKomCredentials({ login: "fixture", password: "fixture-secret" });
  manager.markAuthorized("armtek");
  manager.markAuthorized("part-kom");
  const checked = await testPurchaseOrder(manager, lines, new AbortController().signal, requests);
  assert.equal(checked[0].status, "accepted");
  assert.equal(checked[1].status, "unconfirmed");
  assert.ok(!JSON.stringify(checked).includes("secret"));
  let start;
  const gate = new Promise((resolve) => { start = resolve; });
  const pending = testPurchaseOrder(manager, [lines[0]], new AbortController().signal, { ...requests,
    armtek: async (_credentials, _lines, signal) => { start(); return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); },
  });
  await gate;
  manager.invalidateOperations("armtek");
  assert.equal((await pending)[0].status, "unconfirmed");
});
