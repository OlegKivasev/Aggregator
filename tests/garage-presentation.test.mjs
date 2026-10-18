import assert from "node:assert/strict";
import { test } from "node:test";
import { garageDeliveryWarning } from "../src/frontend/garage-offer-presentation.js";

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
