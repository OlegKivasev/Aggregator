import assert from "node:assert/strict";
import { test } from "node:test";
import { historyItemRows } from "../src/frontend/order-history-presentation.js";

const item = { article: "TEST-1", quantity: 10, price: 100.5, status: "Состояние поставщика", fulfillment: "partial" };
const summary = (rows) => rows.map(({ quantity, fulfillment, status }) => ({ quantity, fulfillment, status }));

test("history presents settled cancellations as received and cancelled rows without a partial status", () => {
  const original = { ...item, fulfillment: "partially_cancelled", fulfillmentQuantities: { delivered: 4, cancelled: 6 } };
  assert.deepEqual(summary(historyItemRows(original)), [
    { quantity: 6, fulfillment: "cancelled", status: "Отменено 6 шт." },
    { quantity: 4, fulfillment: "delivered", status: "Получено 4 шт." },
  ]);
  assert.equal(original.quantity, 10);
  assert.equal(original.fulfillment, "partially_cancelled");
});

test("history keeps an unsettled remainder separate from confirmed receipt and cancellation", () => {
  for (const fulfillment of ["partial", "partially_cancelled"]) {
    const rows = historyItemRows({ ...item, fulfillment, deliveredQuantity: 3, cancelledQuantity: 6 });
    assert.deepEqual(summary(rows), [
      { quantity: 6, fulfillment: "cancelled", status: "Отменено 6 шт." },
      { quantity: 3, fulfillment: "delivered", status: "Получено 3 шт." },
      { quantity: 1, fulfillment: "processing", status: "Ожидается 1 шт." },
    ]);
    assert.equal(rows.reduce((sum, row) => sum + row.quantity, 0), item.quantity);
    assert.equal(rows.reduce((sum, row) => sum + row.quantity * row.price, 0), item.quantity * item.price);
  }
});

test("history shows only confirmed terminal quantities and retains unknown partial details in work", () => {
  assert.deepEqual(summary(historyItemRows({ ...item, deliveredQuantity: 2 })), [
    { quantity: 2, fulfillment: "delivered", status: "Получено 2 шт." },
    { quantity: 8, fulfillment: "processing", status: "Ожидается 8 шт." },
  ]);
  assert.deepEqual(summary(historyItemRows({ ...item, cancelledQuantity: 2 })), [
    { quantity: 2, fulfillment: "cancelled", status: "Отменено 2 шт." },
    { quantity: 8, fulfillment: "processing", status: "Ожидается 8 шт." },
  ]);
  assert.deepEqual(summary(historyItemRows(item)), [
    { quantity: 10, fulfillment: "processing", status: item.status },
  ]);
});

test("ordinary supplier states stay unchanged in the history projection", () => {
  for (const fulfillment of ["processing", "in_transit", "ready", "delivered", "cancelled", "returned", "unknown"]) {
    const original = { ...item, fulfillment };
    assert.deepEqual(historyItemRows(original), [original]);
  }
});
