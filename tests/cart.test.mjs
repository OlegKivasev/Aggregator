import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CartApplicationService } from "../src/backend/purchasing/cart-application-service.ts";
import { SqliteCartRepository } from "../src/backend/purchasing/sqlite-cart-repository.ts";
import { attachPurchaseReference, getPurchaseReference } from "../src/backend/purchasing/purchase-offer.ts";
import { parsePartKomApiResults } from "../src/backend/suppliers/part-kom/part-kom-api-adapter.ts";
import { parseForumAutoApiResults, parseForumAutoApiAnalogResults, parseForumAutoApiResponse } from "../src/backend/suppliers/forum-auto/forum-auto-api-adapter.ts";
import { normalizeRosskoApiSearchResults, normalizeRosskoApiAnalogResults } from "../src/backend/suppliers/rossko/rossko-api-adapter.ts";
import { testPurchaseOrder } from "../src/backend/application/test-order-application-service.ts";
import { parseArmtekOrderResult } from "../src/backend/suppliers/armtek/armtek-order.ts";
import { parseForumAutoOrderResult, placeForumAutoOrder } from "../src/backend/suppliers/forum-auto/forum-auto-api-adapter.ts";
import { buildRosskoOrderEnvelope, parseRosskoOrderResult } from "../src/backend/suppliers/rossko/rossko-api-adapter.ts";
import { getPartKomOrderChoices, parsePartKomMotion } from "../src/backend/suppliers/part-kom/part-kom-order.ts";
import { allowedRosskoOrderChoices, RealOrderApplicationService, resolveRosskoOrderDefaults } from "../src/backend/application/real-order-application-service.ts";
import { SupplierSessionManager } from "../src/backend/session/session-manager.ts";
import { SupplierIntegrationError } from "../src/backend/errors.ts";

// All offers and upstream responses in this file are fictional fixtures.
const suppliers = ["armtek", "part-kom", "forum-auto", "rossko"];
const references = { armtek: { supplier: "armtek", keyzak: "TEST01" }, "part-kom": { supplier: "part-kom", makerId: "101", providerId: "202" },
  "forum-auto": { supplier: "forum-auto", warehouse: "Тестовый склад", gid: "fixture-gid" }, rossko: { supplier: "rossko", partGuid: "fixture-guid", stockId: "fixture-stock" } };
const reference = (supplier = "armtek") => references[supplier];
const supplierOrigins = { armtek: "https://etp.armtek.ru/", "part-kom": "https://www.part-kom.ru/",
  "forum-auto": "https://itrade.forum-auto.ru/", rossko: "https://samara.rossko.ru/" };
const result = (supplier = "armtek", quantity = 4) => attachPurchaseReference({ supplier, brand: "TEST", article: "A1", title: "Тестовая деталь",
  price: 100, quantity, warehouse: "Тестовый склад", deliveryDate: null, deliveryDateApproximate: false, link: supplierOrigins[supplier] }, reference(supplier));
const line = (supplier = "armtek") => ({ id: randomUUID(), result: result(supplier), quantity: 2, reference: reference(supplier) });

const withCart = async (check, testOrder = async () => [], realOrder = null) => {
  const directory = mkdtempSync(join(tmpdir(), "aggregator-cart-"));
  const path = join(directory, "cart.sqlite");
  let service = new CartApplicationService(new SqliteCartRepository(path), testOrder, realOrder);
  try { await check(service, () => { service.close(); service = new CartApplicationService(new SqliteCartRepository(path), testOrder, realOrder); return service; }, path); }
  finally { service.close(); rmSync(directory, { recursive: true, force: true }); }
};

test("PartKOM checkout uses documented regular delivery without requesting pickup points", async () => {
  const sessions = new SupplierSessionManager();
  sessions.setPartKomCredentials({ login: "test", password: "test" });
  const service = new RealOrderApplicationService(sessions, async () => { throw new Error("Unexpected search"); });
  const choices = await service.choices(["part-kom"], new AbortController().signal);
  assert.deepEqual(choices.partKom, getPartKomOrderChoices());
  assert.deepEqual(choices.partKom.deliveries, [
    { id: "regular", type: "regular", label: "Регулярная доставка (ближайшая волна)" },
  ]);
  assert.equal(typeof await service.prepare("part-kom", [line("part-kom")], { partKom: { deliveryId: "regular" } }, new AbortController().signal), "function");
  const fractionalPrice = line("part-kom");
  fractionalPrice.result.price = 1483.07;
  assert.equal(typeof await service.prepare("part-kom", [fractionalPrice], { partKom: { deliveryId: "regular" } }, new AbortController().signal), "function");
  await assert.rejects(service.prepare("part-kom", [line("part-kom")], { partKom: { deliveryId: "pickup:42" } }, new AbortController().signal),
    /delivery settings are invalid/);
});

test("Rossko checkout permits only address delivery and bank transfer", () => {
  const options = { deliveries: [
    { id: "pickup", label: "Самовывоз", addressId: null },
    { id: "courier", label: "Курьерская доставка", addressId: "address-1" },
  ], payments: [
    { id: "1", label: "Оплата банковским платежом" },
    { id: "2", label: "Оплата наличными при получении товара" },
    { id: "3", label: "Оплата картой онлайн" },
  ], companies: [] };
  assert.deepEqual(allowedRosskoOrderChoices(options), { deliveries: [options.deliveries[1]], payments: [options.payments[0]], companies: [] });
  assert.deepEqual(allowedRosskoOrderChoices({ ...options, payments: [{ id: "4", label: "Безналичный расчёт" }] }).payments,
    [{ id: "4", label: "Безналичный расчёт" }]);
  assert.deepEqual(allowedRosskoOrderChoices({ ...options, payments: [{ id: "6", label: "Банковский перевод" }] }).payments,
    [{ id: "6", label: "Банковский перевод" }]);
  assert.throws(() => allowedRosskoOrderChoices({ ...options, payments: [{ id: "5", label: "Безналичный или наличный расчёт" }] }), /bank transfer/);
  assert.throws(() => allowedRosskoOrderChoices({ ...options, payments: options.payments.slice(1) }), /bank transfer/);
  assert.throws(() => allowedRosskoOrderChoices({ ...options, deliveries: options.deliveries.slice(0, 1) }), /delivery address/);
});

test("Rossko default checkout selects the configured buyer, bank payment and whole order", () => {
  const options = { deliveries: [{ id: "pickup", label: "Самовывоз", addressId: null },
    { id: "courier", label: "Доставка", addressId: "address-1" }],
  payments: [{ id: "cash", label: "При получении" }, { id: "bank", label: "Через банк" }],
  companies: [{ id: "other", label: "Другой покупатель" }, { id: "buyer", label: "Тестовый покупатель" }] };
  const config = { buyerName: "Тестовый покупатель", contactName: "Тест", contactPhone: "+70000000000" };
  assert.deepEqual(resolveRosskoOrderDefaults(options, config), { deliveryId: "courier", addressId: "address-1",
    paymentId: "bank", companyId: "buyer", name: "Тест", phone: "+70000000000", deliveryParts: false });
  assert.throws(() => resolveRosskoOrderDefaults(options, { ...config, contactPhone: "" }), /Настройте покупателя/);
  assert.throws(() => resolveRosskoOrderDefaults(options, { ...config, buyerName: "Нет такого" }), /buyer is missing/);
  assert.throws(() => resolveRosskoOrderDefaults({ ...options, deliveries: [...options.deliveries,
    { id: "courier", label: "Другой адрес", addressId: "address-2" }] }, config), /delivery address is ambiguous/);
});

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
    for (const supplier of suppliers) {
      const id = randomUUID();
      cart.registerOffer(id, result(supplier));
      cart.mutate("add", { offerId: id, quantity: 2, revision: cart.view().revision });
    }
    for (const scope of [undefined, null, "stparts", [], {}]) assert.throws(() => cart.clear(scope, 4), /Выберите вкладку/);
    assert.throws(() => cart.clear("all", 1), /Корзина изменилась/);
    assert.equal(cart.view().count, 8);
    const cleared = cart.clear("forum-auto", 4);
    assert.equal(cleared.revision, 5);
    assert.equal(cleared.count, 6);
    assert.ok(cleared.items.every((item) => item.result.supplier !== "forum-auto"));
    assert.equal(cart.clear("forum-auto", 5).revision, 5);
    const restored = reopen();
    assert.equal(restored.view().count, 6);
    assert.equal(restored.clear("rossko", 5).count, 4);
    assert.equal(restored.clear("all", 6).count, 0);
    assert.equal(restored.view().revision, 7);
  });
});

test("cart tests only the selected supplier while keeping all-mode and real-order protection", async () => {
  const calls = [];
  await withCart(async (cart) => {
    for (const supplier of suppliers) {
      const id = randomUUID();
      cart.registerOffer(id, result(supplier));
      cart.mutate("add", { offerId: id, quantity: 1, revision: cart.view().revision });
    }
    const controller = new AbortController();
    for (const [index, supplier] of suppliers.entries()) {
      const selected = await cart.test(4, controller.signal, supplier);
      assert.equal(selected.testOnly, true);
      assert.equal(selected.supplier, supplier);
      assert.equal(selected.results.length, 1);
      assert.deepEqual(calls[index], [supplier]);
    }
    assert.equal((await cart.test(4, controller.signal)).supplier, "all");
    assert.deepEqual(calls[4], suppliers);
    await assert.rejects(cart.test(4, controller.signal, "stparts"), /Выберите вкладку/);
    await assert.rejects(cart.test(3, controller.signal), /Корзина изменилась/);
    assert.equal(calls.length, 5);
    cart.clear("rossko", 4);
    await assert.rejects(cart.test(5, controller.signal, "rossko"), /выбранную вкладку/);
    assert.equal(cart.view().count, 3);
  }, async (lines) => {
    calls.push(lines.map((line) => line.reference.supplier));
    return testPurchaseOrder(lines, new AbortController().signal);
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

test("Forum Auto and Rossko exact and analog offers keep real references private", () => {
  const forumPayload = [{ gid: "fixture-gid", art: "A1", brand: "TEST", name: "Тест", price: 100, num: 4, whse: "Тестовый склад" }];
  const [forum] = parseForumAutoApiResults(forumPayload, "A1");
  assert.deepEqual(getPurchaseReference(forum), reference("forum-auto"));
  const [forumAnalog] = parseForumAutoApiAnalogResults(forumPayload, "OTHER", "TEST");
  assert.deepEqual(getPurchaseReference(forumAnalog), reference("forum-auto"));
  const rosskoPart = { guid: "fixture-guid", brand: "TEST", article: "A1", title: "Тест", crosses: [],
    stocks: [{ id: "fixture-stock", price: 100, quantity: 4, warehouse: "Тестовый склад", deliveryDays: null, deliveryStart: null, deliveryEnd: null }] };
  const [rossko] = normalizeRosskoApiSearchResults([rosskoPart], "A1");
  assert.deepEqual(getPurchaseReference(rossko), reference("rossko"));
  const [rosskoAnalog] = normalizeRosskoApiAnalogResults([{ ...rosskoPart, article: "OTHER", crosses: [rosskoPart] }], "OTHER", "TEST");
  assert.deepEqual(getPurchaseReference(rosskoAnalog), reference("rossko"));
  assert.ok(!JSON.stringify(rossko).includes("fixture-guid"));
  assert.ok(!JSON.stringify(rossko).includes("fixture-stock"));
});

test("new supplier cart offers persist, keep warehouses separate and merge repeats with updated quotes", async () => {
  await withCart((cart, reopen) => {
    for (const supplier of ["forum-auto", "rossko"]) {
      const add = (offer) => {
        const id = randomUUID();
        cart.registerOffer(id, offer);
        return cart.mutate("add", { offerId: id, quantity: 1, revision: cart.view().revision });
      };
      add(result(supplier));
      add(result(supplier));
      const other = result(supplier);
      other.warehouse = "Другой тестовый склад";
      attachPurchaseReference(other, supplier === "forum-auto" ? { supplier, warehouse: other.warehouse, gid: "other-fixture-gid" }
        : { ...reference(supplier), stockId: "other-fixture-stock" });
      add(other);
      const otherPrice = result(supplier);
      otherPrice.price = 101;
      add(otherPrice);
      const otherDelivery = result(supplier);
      otherDelivery.deliveryDate = "2028-03-15T12:00:00Z";
      add(otherDelivery);
      for (const quantity of [null, 0, undefined]) {
        const invalid = result(supplier);
        invalid.quantity = quantity;
        assert.throws(() => add(invalid), /не поддерживает/);
      }
    }
    const restored = reopen().view();
    assert.equal(restored.items.length, 4);
    assert.equal(restored.count, 10);
    assert.equal(restored.items.filter((item) => item.quantity === 4).length, 2);
    assert.ok(restored.items.filter((item) => item.quantity === 4).every((item) => item.result.deliveryDate === "2028-03-15T12:00:00Z"));
    assert.ok(!JSON.stringify(restored).includes("fixture-stock"));
  });
});

test("demo completion covers all suppliers without credentials, keeps the cart and honors abort", async () => {
  const lines = suppliers.map((supplier) => line(supplier));
  const completed = await testPurchaseOrder(lines, new AbortController().signal);
  assert.deepEqual(completed.map((item) => item.id), lines.map((item) => item.id));
  assert.ok(completed.every((item) => item.status === "simulated" && item.acceptedQuantity === null && /не отправлен/.test(item.message)));
  const controller = new AbortController();
  controller.abort(new Error("Fixture abort"));
  await assert.rejects(testPurchaseOrder(lines, controller.signal), /Fixture abort/);
  await withCart(async (cart) => {
    for (const supplier of suppliers) {
      const id = randomUUID();
      cart.registerOffer(id, result(supplier));
      cart.mutate("add", { offerId: id, quantity: 1, revision: cart.view().revision });
    }
    const before = cart.view();
    assert.equal((await cart.test(before.revision, new AbortController().signal)).results.length, 4);
    assert.deepEqual(cart.view(), before);
  }, testPurchaseOrder);
});

test("real checkout removes only confirmed quantities and preserves rejected items", async () => {
  const calls = [];
  const gateway = {
    refresh: async (lines) => lines,
    choices: async () => ({}),
    prepare: async (supplier, lines) => async () => {
      calls.push(supplier);
      return supplier === "armtek"
        ? { confirmed: [{ id: lines[0].id, acceptedQuantity: 1, orderIds: ["A-1"], message: "Часть количества" }], rejected: [] }
        : { confirmed: [], rejected: [{ id: lines[0].id, message: "Нет в наличии" }] };
    },
  };
  await withCart(async (cart, reopen) => {
    for (const supplier of ["armtek", "forum-auto"]) {
      const id = randomUUID();
      cart.registerOffer(id, result(supplier));
      cart.mutate("add", { offerId: id, quantity: 2, revision: cart.view().revision });
    }
    await cart.refreshForOrder(2, "all", new AbortController().signal);
    const response = await cart.order(2, "all", cart.view().items.map((item) => item.id), {}, new AbortController().signal);
    assert.deepEqual(calls, ["armtek", "forum-auto"]);
    assert.equal(response.results.length, 2);
    assert.equal(response.cart.count, 3);
    assert.equal(response.cart.revision, 3);
    assert.deepEqual(response.cart.pendingIds, []);
    assert.equal(reopen().view().count, 3);
  }, undefined, gateway);
});

test("refreshing the whole cart authorizes a supplier tab without another refresh", async () => {
  let refreshes = 0;
  const gateway = {
    refresh: async (lines) => { refreshes++; return lines; },
    choices: async () => ({}),
    prepare: async (_supplier, lines) => async () => ({
      confirmed: lines.map((item) => ({ id: item.id, acceptedQuantity: item.quantity, orderIds: ["A-1"] })), rejected: [],
    }),
  };
  await withCart(async (cart) => {
    for (const supplier of ["armtek", "forum-auto"]) {
      const id = randomUUID();
      cart.registerOffer(id, result(supplier));
      cart.mutate("add", { offerId: id, quantity: 1, revision: cart.view().revision });
    }
    await cart.refreshForOrder(2, "all", new AbortController().signal);
    const response = await cart.order(2, "armtek", cart.view().items.filter((item) => item.result.supplier === "armtek").map((item) => item.id), {}, new AbortController().signal);
    assert.equal(refreshes, 1);
    assert.equal(response.cart.count, 1);
    assert.equal(response.cart.items[0].result.supplier, "forum-auto");
  }, undefined, gateway);
});

test("real checkout sends only selected lines and leaves other cart goods untouched", async () => {
  const prepared = [];
  const choicesFor = [];
  const gateway = {
    refresh: async (lines) => lines,
    choices: async (suppliers) => { choicesFor.push(suppliers); return {}; },
    prepare: async (supplier, lines) => {
      prepared.push({ supplier, ids: lines.map((item) => item.id) });
      return async () => ({ confirmed: lines.map((item) => ({ id: item.id, acceptedQuantity: item.quantity, orderIds: ["A-1"] })), rejected: [] });
    },
  };
  await withCart(async (cart) => {
    for (const supplier of ["armtek", "forum-auto"]) {
      const id = randomUUID();
      cart.registerOffer(id, result(supplier));
      cart.mutate("add", { offerId: id, quantity: 1, revision: cart.view().revision });
    }
    const items = cart.view().items;
    const selected = [items[1].id];
    await cart.refreshForOrder(2, "all", new AbortController().signal);
    await cart.orderChoices(2, "all", new AbortController().signal, selected);
    assert.deepEqual(choicesFor, [["forum-auto"]]);
    await assert.rejects(cart.order(2, "all", [], {}, new AbortController().signal), /Выберите товары/);
    await assert.rejects(cart.order(2, "all", [items[0].id, items[0].id], {}, new AbortController().signal), /Выберите товары/);
    await assert.rejects(cart.order(2, "armtek", selected, {}, new AbortController().signal), /Выбранные товары изменились/);
    const response = await cart.order(2, "all", selected, {}, new AbortController().signal);
    assert.deepEqual(prepared, [{ supplier: "forum-auto", ids: selected }]);
    assert.equal(response.cart.items.length, 1);
    assert.equal(response.cart.items[0].id, items[0].id);
  }, undefined, gateway);
});

test("uncertain supplier response remains in cart and blocks duplicate checkout after restart", async () => {
  let calls = 0;
  const gateway = { refresh: async (lines) => lines, choices: async () => ({}), prepare: async () => async () => { calls++; throw new Error("Connection lost"); } };
  await withCart(async (cart, reopen) => {
    const id = randomUUID();
    cart.registerOffer(id, result());
    cart.mutate("add", { offerId: id, quantity: 1, revision: 0 });
    await cart.refreshForOrder(1, "armtek", new AbortController().signal);
    const response = await cart.order(1, "armtek", cart.view().items.map((item) => item.id), {}, new AbortController().signal);
    assert.equal(response.results[0].status, "uncertain");
    assert.equal(response.cart.count, 1);
    assert.equal(response.cart.pendingIds.length, 1);
    const restored = reopen();
    await assert.rejects(restored.order(1, "armtek", restored.view().items.map((item) => item.id), {}, new AbortController().signal), /сверить/);
    assert.throws(() => restored.clear("armtek", 1), /сверить/);
    assert.equal(calls, 1);
  }, undefined, gateway);
});

test("verified missing Forum Auto order can be unlocked while retaining the attempt record", async () => {
  const gateway = { refresh: async (lines) => lines, choices: async () => ({}), prepare: async () => async () => { throw new Error("Connection lost"); } };
  await withCart(async (cart, reopen, path) => {
    const offerId = randomUUID();
    cart.registerOffer(offerId, result("forum-auto"));
    cart.mutate("add", { offerId, quantity: 1, revision: 0 });
    await cart.refreshForOrder(1, "forum-auto", new AbortController().signal);
    const itemId = cart.view().items[0].id;
    const attempt = await cart.order(1, "forum-auto", [itemId], {}, new AbortController().signal);
    assert.equal(attempt.results[0].status, "uncertain");
    assert.deepEqual(attempt.cart.pendingIds, [itemId]);
    assert.throws(() => cart.resolveUncertainForumAutoLine(itemId, attempt.cart.revision, false), /Подтвердите/);
    assert.throws(() => cart.resolveUncertainForumAutoLine(itemId, attempt.cart.revision - 1, true), /Корзина изменилась/);
    const resolved = cart.resolveUncertainForumAutoLine(itemId, attempt.cart.revision, true);
    assert.equal(resolved.count, 1);
    assert.deepEqual(resolved.pendingIds, []);
    const restored = reopen();
    assert.deepEqual(restored.view().pendingIds, []);
    const database = new DatabaseSync(path);
    try {
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM purchase_order_attempt WHERE state = 'uncertain'").get().count, 1);
      assert.equal(database.prepare("SELECT resolution FROM purchase_order_resolution").get().resolution, "customer_verified_missing");
    } finally { database.close(); }
    assert.throws(() => restored.resolveUncertainForumAutoLine(itemId, resolved.revision, true), /Не найдена/);
  }, undefined, gateway);
});

test("an uncertain Forum Auto creation fault exposes only its safe code", async () => {
  const gateway = { refresh: async (lines) => lines, choices: async () => ({}), prepare: async () => async () => {
    throw new SupplierIntegrationError("Internal upstream details", { diagnosticCode: "forum_auto_fault_25" });
  } };
  await withCart(async (cart) => {
    const offerId = randomUUID();
    cart.registerOffer(offerId, result("forum-auto"));
    cart.mutate("add", { offerId, quantity: 1, revision: 0 });
    await cart.refreshForOrder(1, "forum-auto", new AbortController().signal);
    const response = await cart.order(1, "forum-auto", [cart.view().items[0].id], {}, new AbortController().signal);
    assert.match(response.results[0].message, /код 25/);
    assert.doesNotMatch(response.results[0].message, /Internal upstream details/);
  }, undefined, gateway);
});

test("an uncertain Forum Auto response shows its order number for supplier verification", async () => {
  const gateway = { refresh: async (lines) => lines, choices: async () => ({}), prepare: async () => async () => {
    throw new SupplierIntegrationError("Forum-Auto order confirmation is incomplete", {
      publicMessage: "Forum Auto вернул заказ №42, но не подтвердил выбранную позицию. Найдите заказ по номеру в кабинете поставщика.",
    });
  } };
  await withCart(async (cart) => {
    const offerId = randomUUID();
    cart.registerOffer(offerId, result("forum-auto"));
    cart.mutate("add", { offerId, quantity: 1, revision: 0 });
    await cart.refreshForOrder(1, "forum-auto", new AbortController().signal);
    const response = await cart.order(1, "forum-auto", [cart.view().items[0].id], {}, new AbortController().signal);
    assert.match(response.results[0].message, /№42/);
    assert.deepEqual(response.cart.pendingIds, [cart.view().items[0].id]);
  }, undefined, gateway);
});

test("an existing Forum Auto cart line obtains a fresh product id before order", async () => {
  const gateway = { refresh: async (lines) => lines.map((item) => ({ ...item, reference: reference("forum-auto"), result: { ...item.result, price: 125 } })),
    choices: async () => ({}), prepare: async (_supplier, lines) => async () => ({ confirmed: [{ id: lines[0].id, acceptedQuantity: 2, orderIds: ["F-1"] }], rejected: [] }) };
  await withCart(async (cart, _reopen, path) => {
    const oldLine = structuredClone(line("forum-auto"));
    delete oldLine.reference.gid;
    const repository = new SqliteCartRepository(path);
    assert.equal(repository.save({ revision: 1, lines: [oldLine] }, 0), true);
    repository.close();
    assert.equal(cart.view().items.length, 1);
    await assert.rejects(cart.order(1, "forum-auto", cart.view().items.map((item) => item.id), {}, new AbortController().signal), /Сначала обновите/);
    const refreshed = await cart.refreshForOrder(1, "forum-auto", new AbortController().signal);
    assert.equal(refreshed.revision, 2);
    assert.equal(refreshed.items[0].result.price, 125);
    assert.equal((await cart.order(2, "forum-auto", cart.view().items.map((item) => item.id), {}, new AbortController().signal)).cart.count, 0);
  }, undefined, gateway);
});

test("supplier refresh matches a legacy Forum Auto row and rejects ambiguous or insufficient offers", async () => {
  const oldLine = structuredClone(line("forum-auto"));
  delete oldLine.reference.gid;
  const fresh = result("forum-auto", 3);
  fresh.price = 125;
  const service = new RealOrderApplicationService(new SupplierSessionManager(), async (_query, emit) => {
    emit({ type: "result", result: fresh });
    emit({ type: "supplier_status", supplier: "forum-auto", status: "completed" });
  });
  const [updated] = await service.refresh([oldLine], new AbortController().signal);
  assert.equal(updated.reference.gid, "fixture-gid");
  assert.equal(updated.result.price, 125);
  const ambiguous = new RealOrderApplicationService(new SupplierSessionManager(), async (_query, emit) => {
    emit({ type: "result", result: fresh });
    emit({ type: "result", result: result("forum-auto") });
    emit({ type: "supplier_status", supplier: "forum-auto", status: "completed" });
  });
  await assert.rejects(ambiguous.refresh([oldLine], new AbortController().signal), /ambiguous/);
  const scarce = result("forum-auto", 1);
  const insufficient = new RealOrderApplicationService(new SupplierSessionManager(), async (_query, emit) => {
    emit({ type: "result", result: scarce });
    emit({ type: "supplier_status", supplier: "forum-auto", status: "completed" });
  });
  await assert.rejects(insufficient.refresh([oldLine], new AbortController().signal), /insufficient/);
});

test("refresh failure keeps the cart unchanged and cannot authorize a real order", async () => {
  let sends = 0;
  const gateway = { refresh: async () => { throw new Error("Supplier unavailable"); }, choices: async () => ({}),
    prepare: async () => async () => { sends++; return { confirmed: [], rejected: [] }; } };
  await withCart(async (cart) => {
    const offerId = randomUUID();
    cart.registerOffer(offerId, result());
    const before = cart.mutate("add", { offerId, quantity: 2, revision: 0 });
    await assert.rejects(cart.refreshForOrder(before.revision, "armtek", new AbortController().signal), /Supplier unavailable/);
    assert.deepEqual(cart.view(), before);
    await assert.rejects(cart.order(before.revision, "armtek", before.items.map((item) => item.id), {}, new AbortController().signal), /Сначала обновите/);
    assert.equal(sends, 0);
  }, undefined, gateway);
});

test("supplier order parsers require matching real confirmations", () => {
  const armtek = line("armtek");
  assert.deepEqual(parseArmtekOrderResult({ ITEMS: [{ PIN: "A1", BRAND: "TEST", KEYZAK: "TEST01", REMAIN: "0",
    RESULT: [{ KWMENG: "2", KEYZAK: "TEST01", VBELN: "A-1" }] }] }, [armtek]).confirmed[0].acceptedQuantity, 2);
  assert.throws(() => parseArmtekOrderResult({ ITEMS: [{ PIN: "A1", BRAND: "TEST", KEYZAK: "TEST01", REMAIN: "0", RESULT: [] }] }, [armtek]));
  const forum = line("forum-auto");
  assert.equal(parseForumAutoOrderResult([{ did: 42, arTovs: [{ gid: "fixture-gid", k1: 2 }] }], forum).confirmed[0].orderIds[0], "42");
  assert.deepEqual(parseForumAutoOrderResult([{ did: 42, dtc: "15.10.2026 12:30:00", status: "Отправлен на бронирование",
    mdt: "17.10.2026 09:00:00", arTovs: [{ gid: "fixture-gid", k1: 2, k2: 1, k3: 0, brand: "TEST",
      nr: "A1", tovname: "Деталь", price: 120, sum: 240 }] }], forum).confirmed[0].forumAutoOrder,
  { orderId: "42", orderedQuantity: 2, status: "Отправлен на бронирование", createdAt: "15.10.2026 12:30:00",
    deliveryAt: "17.10.2026 09:00:00", brand: "TEST", article: "A1", title: "Деталь",
    reservedQuantity: 1, confirmedQuantity: 0, price: 120, total: 240 });
  assert.deepEqual(parseForumAutoOrderResult([{ did: 42, status: { invalid: true }, arTovs: [{ gid: "fixture-gid", k1: 2,
    k2: -1, k3: 3, price: "bad", sum: Infinity }] }], forum).confirmed[0].forumAutoOrder,
  { orderId: "42", orderedQuantity: 2 });
  assert.throws(() => parseForumAutoOrderResult([{ did: 42, arTovs: [] }], forum));
  assert.throws(() => parseForumAutoOrderResult([{ did: 42, arTovs: [{ gid: "other-gid", k1: 2 }] }], forum),
    (error) => error.publicMessage.includes("№42") && !error.publicMessage.includes("other-gid"));
  assert.throws(() => parseForumAutoOrderResult([], forum),
    (error) => error.publicMessage.includes("пустой ответ") && !error.publicMessage.includes("№"));
  const partKom = line("part-kom");
  assert.equal(parsePartKomMotion([{ orderNumber: "P-1", detailNum: "A1", providerId: 202, quantity: 2 }], partKom).confirmed[0].acceptedQuantity, 2);
  assert.deepEqual(parsePartKomMotion([{ orderNumber: "P-1", orderDate: "2026-10-15 12:33:00", detailNum: "A1", maker: "TEST",
    description: "Тестовая деталь", providerId: 202, quantity: 2, price: "1483.07", stateTxt: "Принят в работу",
    expectedDate: "2026-10-17", guaranteedDate: "2026-10-20", placement: "Склад", refusalCount: 0,
    storeCount: 0, releaseCount: 0, comment: "Комментарий" }], partKom).confirmed[0].partKomOrders,
  [{ orderNumber: "P-1", quantity: 2, orderDate: "2026-10-15 12:33:00", detailNum: "A1", maker: "TEST",
    description: "Тестовая деталь", price: 1483.07, stateTxt: "Принят в работу", expectedDate: "2026-10-17",
    guaranteedDate: "2026-10-20", placement: "Склад", refusalCount: 0, storeCount: 0, releaseCount: 0,
    comment: "Комментарий" }]);
  assert.deepEqual(parsePartKomMotion([{ orderNumber: "P-2", detailNum: "A1", providerId: 202, quantity: 2,
    stateTxt: { unexpected: "data" }, price: "invalid", refusalCount: -1 }], partKom).confirmed[0].partKomOrders,
  [{ orderNumber: "P-2", quantity: 2, detailNum: "A1" }]);
  assert.equal(parsePartKomMotion([], partKom), null);
  const rossko = line("rossko");
  const credentials = { key1: "fixture-one", key2: "fixture-two" };
  const envelope = buildRosskoOrderEnvelope(credentials,
    { deliveryId: "1", addressId: null, paymentId: "2", companyId: null, name: "Тест", phone: "+70000000000", deliveryParts: false }, [rossko]);
  assert.match(envelope, /<ros:stock>fixture-stock<\/ros:stock>/);
  const xml = `<Envelope><Body><CheckoutResult><success>true</success><ItemsList><Item><partnumber>A1</partnumber><brand>TEST</brand>
    <stock>fixture-stock</stock><count>2</count><order_id>77</order_id></Item></ItemsList></CheckoutResult></Body></Envelope>`;
  assert.equal(parseRosskoOrderResult(xml, [rossko]).confirmed[0].orderIds[0], "77");
  assert.throws(() => parseRosskoOrderResult(xml.replace("fixture-stock", "wrong-stock"), [rossko]));
});

test("Forum Auto verifies an incomplete creation response with a read-only order lookup", async () => {
  const calls = [];
  const orderedLine = line("forum-auto");
  const attemptId = "11111111-1111-4111-8111-111111111111";
  const request = async (method, params) => {
    calls.push({ method, params: Object.fromEntries(params) });
    return method === "addgoodstoorder" ? [{ did: 42, arTovs: [] }]
      : [{ did: 42, status: "Отправлен на бронирование", arTovs: [{ gid: "fixture-gid", k1: 2 }] }];
  };
  const response = await placeForumAutoOrder(orderedLine, { login: "fixture", password: "fixture" }, new AbortController().signal, attemptId, request);
  assert.equal(response.confirmed[0].forumAutoOrder.status, "Отправлен на бронирование");
  assert.deepEqual(calls.map(({ method }) => method), ["addgoodstoorder", "listorders"]);
  assert.deepEqual({ tid: calls[0].params.tid, num: calls[0].params.num }, { tid: "fixture-gid", num: "2" });
  assert.match(calls[0].params.eoid, /^[1-9]\d*$/);
  assert.deepEqual(calls[1].params, { did: "42" });
  await assert.rejects(placeForumAutoOrder(orderedLine, { login: "fixture", password: "fixture" },
    new AbortController().signal, attemptId, async (method) => method === "addgoodstoorder" ? [{ did: 42, arTovs: [] }]
      : [{ did: 42, arTovs: [{ gid: "different-gid", k1: 2 }] }]), /incomplete/);
});

test("Forum Auto checks an externally tagged order after a lost creation response without resubmitting it", async () => {
  const orderedLine = line("forum-auto");
  const calls = [];
  let externalOrderId;
  const response = await placeForumAutoOrder(orderedLine, { login: "fixture", password: "fixture" },
    new AbortController().signal, "22222222-2222-4222-8222-222222222222", async (method, params) => {
      calls.push(method);
      if (method === "addgoodstoorder") {
        externalOrderId = params.get("eoid");
        throw new Error("Connection lost");
      }
      assert.deepEqual(Object.fromEntries(params), { did: "0" });
      return [{ did: 71, eoid: externalOrderId, arTovs: [{ gid: "fixture-gid", k1: 2 }] }];
    });
  assert.equal(response.confirmed[0].orderIds[0], "71");
  assert.deepEqual(calls, ["addgoodstoorder", "listorders"]);
});

test("Forum Auto treats a documented order refusal as rejected without leaving an uncertain attempt", async () => {
  const orderedLine = line("forum-auto");
  for (const status of [200, 400]) {
    let calls = 0;
    const response = await placeForumAutoOrder(orderedLine, { login: "fixture", password: "fixture" },
      new AbortController().signal, "33333333-3333-4333-8333-333333333333", async (method) => {
        calls++;
        assert.equal(method, "addgoodstoorder");
        return parseForumAutoApiResponse({ status, contentType: "application/json", setCookie: [],
          body: JSON.stringify({ FaultCode: 28 }) }, method);
      });
    assert.deepEqual(response, { confirmed: [], rejected: [{ id: orderedLine.id,
      message: "Forum Auto отклонил количество: оно меньше кратности упаковки." }] });
    assert.equal(calls, 1);
  }
});
