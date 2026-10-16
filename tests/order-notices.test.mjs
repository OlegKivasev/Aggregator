import assert from "node:assert/strict";
import { test } from "node:test";
import { formatArmtekReturnDays, hasPartKomWeekendDelivery, renderDeliveryWarning } from "../src/frontend/order-notices.js";

test("PartKOM warns for weekend dates and range ends without flagging other suppliers or invalid dates", () => {
  for (const date of ["2026-10-17", "2026-10-18 09:30:00"]) {
    assert.equal(hasPartKomWeekendDelivery("part-kom", date), true);
    assert.match(renderDeliveryWarning("part-kom", date), /delivery-warning/);
    assert.equal(hasPartKomWeekendDelivery("armtek", date), false);
  }
  assert.equal(hasPartKomWeekendDelivery("part-kom", "2026-10-16", "2026-10-17"), true);
  for (const date of [null, undefined, "", "2026-10-16", "2026-10-19", "2026-02-30", "2026-10-17 99:00", "<img src=x>", 0]) {
    assert.equal(renderDeliveryWarning("part-kom", date), "");
  }
});

test("Armtek distinguishes unknown periods from a confirmed return prohibition", () => {
  assert.equal(formatArmtekReturnDays(14), "Возврат: 14 дн.");
  assert.equal(formatArmtekReturnDays(0), "Возврат недоступен");
  for (const value of [undefined, null, false, "14", -1, 1.5, Infinity, 10000, {}]) {
    assert.equal(formatArmtekReturnDays(value), "Срок возврата не указан");
  }
});
