import assert from "node:assert/strict";
import { test } from "node:test";
import { formatOrderDate } from "../src/frontend/order-date-formatting.js";

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
