import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePartKomOrderHistory } from "../src/backend/suppliers/part-kom/part-kom-order.ts";

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
