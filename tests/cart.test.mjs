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

// All offers and upstream responses in this file are fictional fixtures.
const suppliers = ["armtek", "part-kom", "forum-auto", "rossko"];
const references = { armtek: { supplier: "armtek", keyzak: "TEST01" }, "part-kom": { supplier: "part-kom", makerId: "101", providerId: "202" },
  "forum-auto": { supplier: "forum-auto", warehouse: "Тестовый склад" }, rossko: { supplier: "rossko", partGuid: "fixture-guid", stockId: "fixture-stock" } };
const reference = (supplier = "armtek") => references[supplier];
const supplierOrigins = { armtek: "https://etp.armtek.ru/", "part-kom": "https://www.part-kom.ru/",
  "forum-auto": "https://itrade.forum-auto.ru/", rossko: "https://samara.rossko.ru/" };
const result = (supplier = "armtek", quantity = 4) => attachPurchaseReference({ supplier, brand: "TEST", article: "A1", title: "Тестовая деталь",
  price: 100, quantity, warehouse: "Тестовый склад", deliveryDate: null, deliveryDateApproximate: false, link: supplierOrigins[supplier] }, reference(supplier));
const line = (supplier = "armtek") => ({ id: randomUUID(), result: result(supplier), quantity: 2, reference: reference(supplier) });

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
  const forumPayload = [{ art: "A1", brand: "TEST", name: "Тест", price: 100, num: 4, whse: "Тестовый склад" }];
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
      attachPurchaseReference(other, supplier === "forum-auto" ? { supplier, warehouse: other.warehouse }
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
