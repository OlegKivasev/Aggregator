import assert from "node:assert/strict";
import { test } from "node:test";
import { garageDeliveryWarning, garageCartWarning } from "../src/frontend/garage-offer-presentation.js";

test("garage identifies unconfirmed snapshots and expired delivery ranges by Samara's current day", () => {
  const now = Date.parse("2026-10-17T20:01:00Z");
  const item = { availabilityStatus: "available", deliveryDate: "2026-10-05", deliveryDateTo: null };
  assert.equal(garageDeliveryWarning(item, now), "Срок доставки устарел");
  assert.equal(garageDeliveryWarning({ ...item, availabilityStatus: "supplier_error" }, now), "Не удалось проверить");
  assert.equal(garageDeliveryWarning({ ...item, availabilityStatus: "not_found" }, now), "Предложение не подтверждено");
  assert.equal(garageDeliveryWarning({ ...item, deliveryDate: "2026-10-18" }, now), null);
  assert.equal(garageDeliveryWarning({ ...item, deliveryDateTo: "2026-10-20" }, now), null);
  assert.equal(garageDeliveryWarning({ ...item, deliveryDate: null }, now), null);
});

test("garage cart controls exclude unconfirmed stock, unsupported suppliers, past dates and fractional quantities", () => {
  const now = Date.parse("2026-10-18T10:00:00Z");
  const item = { supplier: "armtek", availabilityStatus: "available", supplierQuantity: 4, requiredQuantity: 2, deliveryDate: null };
  assert.equal(garageCartWarning(item, now), null);
  assert.equal(garageCartWarning({ ...item, availabilityStatus: "insufficient" }, now), null, "lowering the required quantity can restore the cart button before the next refresh");
  for (const change of [{ availabilityStatus: "not_found" }, { availabilityStatus: "supplier_error" }, { supplierQuantity: null },
    { availabilityStatus: "unknown" }, { requiredQuantity: .5 }, { supplierQuantity: 1 }, { supplier: "stparts" }, { deliveryDate: "2026-10-05" }]) {
    assert.equal(typeof garageCartWarning({ ...item, ...change }, now), "string");
  }
});
