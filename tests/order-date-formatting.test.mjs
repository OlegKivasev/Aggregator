import assert from "node:assert/strict";
import { test } from "node:test";
import { formatOrderDate, latestDeliveryDay, orderCalendarDay } from "../src/frontend/order-date-formatting.js";

test("order dates use one format and preserve the supplier's clock without a timezone shift", () => {
  for (const value of ["2026-10-18 02:41:00", "2026-10-18T02:41:00", "18.10.2026 02:41:00", "18.10.2026 02:41"]) {
    assert.equal(formatOrderDate(value), "18.10.2026 02:41");
  }
  assert.equal(formatOrderDate("2026-12-31 23:59:59"), "31.12.2026 23:59");
});

test("date-only supplier values do not gain an invented time and absent dates stay absent", () => {
  assert.equal(formatOrderDate("2024-02-29"), "29.02.2024");
  assert.equal(formatOrderDate("18.10.2026"), "18.10.2026");
  assert.equal(formatOrderDate("2026-11-25"), "25.11.2026");
  for (const value of [null, undefined, "", " ", 20261018, {}]) assert.equal(formatOrderDate(value), null);
});

test("unrecognized supplier text and invalid dates are preserved without fabricating a date", () => {
  for (const value of ["Уточняется", "2026-02-29", "31.04.2026", "2026-10-18 25:00:00", "2026-10-18 12:60:00"]) {
    assert.equal(formatOrderDate(value), value);
  }
});

test("1C delivery uses the latest calendar day and keeps the supplier's local date", () => {
  assert.equal(latestDeliveryDay("2026-11-26 09:36", "27.11.2026 08:00"), "2026-11-27");
  assert.equal(latestDeliveryDay("2026-11-27", "26.11.2026"), "2026-11-27");
  assert.equal(latestDeliveryDay("26–27.11.2026"), "2026-11-27");
  assert.equal(latestDeliveryDay("30.11.2026 - 01.12.2026"), "2026-12-01");
  assert.equal(latestDeliveryDay("2026-11-30–2026-12-01"), "2026-12-01");
  assert.equal(latestDeliveryDay("2026-11-30-2026-12-01"), "2026-12-01");
  assert.equal(latestDeliveryDay("30.11.2026", "31.11.2026"), "2026-11-30");
  assert.equal(latestDeliveryDay(null, undefined, "26-27", "Уточняется", "0001-01-01"), null);
  assert.equal(orderCalendarDay("2026-11-27T01:00:00+04:00"), "2026-11-27");
});
