import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CartApplicationService } from "../src/backend/purchasing/cart-application-service.ts";
import { SqliteCartRepository } from "../src/backend/purchasing/sqlite-cart-repository.ts";
import { attachPurchaseReference, getPurchaseReference } from "../src/backend/purchasing/purchase-offer.ts";
import { parsePartKomApiResults } from "../src/backend/suppliers/part-kom/part-kom-api-adapter.ts";
import { parseForumAutoApiResults, parseForumAutoApiAnalogResults } from "../src/backend/suppliers/forum-auto/forum-auto-api-adapter.ts";
import { normalizeRosskoApiSearchResults, normalizeRosskoApiAnalogResults } from "../src/backend/suppliers/rossko/rossko-api-adapter.ts";
import { testPurchaseOrder } from "../src/backend/application/test-order-application-service.ts";
import { parseArmtekOrderResult } from "../src/backend/suppliers/armtek/armtek-order.ts";
import { parseForumAutoOrderResult } from "../src/backend/suppliers/forum-auto/forum-auto-api-adapter.ts";
import { buildRosskoOrderEnvelope, parseRosskoOrderResult } from "../src/backend/suppliers/rossko/rossko-api-adapter.ts";
import { parsePartKomMotion } from "../src/backend/suppliers/part-kom/part-kom-order.ts";
import { RealOrderApplicationService } from "../src/backend/application/real-order-application-service.ts";
import { SupplierSessionManager } from "../src/backend/session/session-manager.ts";

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
    const response = await cart.order(2, "all", {}, new AbortController().signal);
    assert.deepEqual(calls, ["armtek", "forum-auto"]);
    assert.equal(response.results.length, 2);
    assert.equal(response.cart.count, 3);
    assert.equal(response.cart.revision, 3);
    assert.equal(reopen().view().count, 3);
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
    const response = await cart.order(1, "armtek", {}, new AbortController().signal);
    assert.equal(response.results[0].status, "uncertain");
    assert.equal(response.cart.count, 1);
    assert.equal(response.cart.pendingIds.length, 1);
    const restored = reopen();
    await assert.rejects(restored.order(1, "armtek", {}, new AbortController().signal), /сверить/);
    assert.throws(() => restored.clear("armtek", 1), /сверить/);
    assert.equal(calls, 1);
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
    await assert.rejects(cart.order(1, "forum-auto", {}, new AbortController().signal), /Сначала обновите/);
    const refreshed = await cart.refreshForOrder(1, "forum-auto", new AbortController().signal);
    assert.equal(refreshed.revision, 2);
    assert.equal(refreshed.items[0].result.price, 125);
    assert.equal((await cart.order(2, "forum-auto", {}, new AbortController().signal)).cart.count, 0);
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
    await assert.rejects(cart.order(before.revision, "armtek", {}, new AbortController().signal), /Сначала обновите/);
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
  assert.throws(() => parseForumAutoOrderResult([{ did: 42, arTovs: [] }], forum));
  const partKom = line("part-kom");
  assert.equal(parsePartKomMotion([{ orderNumber: "P-1", detailNum: "A1", providerId: 202, quantity: 2 }], partKom).confirmed[0].acceptedQuantity, 2);
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
