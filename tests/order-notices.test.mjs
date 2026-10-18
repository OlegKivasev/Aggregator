import assert from "node:assert/strict";
import { test } from "node:test";
import { formatArmtekReturnDays, hasOfferDeliveryWarning, hasSupplierWeekendDelivery } from "../src/frontend/order-notices.js";

test("PartKOM and Forum Auto highlight weekends with at most the preceding Friday and exclude other workdays", () => {
  for (const date of ["2026-10-17", "2026-10-18 09:30:00"]) {
    assert.equal(hasSupplierWeekendDelivery("part-kom", date), true);
    assert.equal(hasSupplierWeekendDelivery("forum-auto", date), true);
    assert.equal(hasSupplierWeekendDelivery("armtek", date), false);
  }
  assert.equal(hasSupplierWeekendDelivery("part-kom", "2026-10-16", "2026-10-17"), true);
  for (const [from, to, expected] of [
    ["2026-10-17", "2026-10-18", true],
    ["2026-10-16", "2026-10-18", true],
    ["2026-10-17", "2026-10-20", false],
    ["2026-10-18", "2026-10-21", false],
    ["2026-10-15", "2026-10-17", false],
    ["2026-10-16", "2026-10-19", false],
    ["2026-10-17", "2026-10-25", false],
    ["2026-10-18", "2026-10-17", false],
    ["2026-10-17", "invalid", false],
  ]) {
    assert.equal(hasSupplierWeekendDelivery("part-kom", from, to), expected, `${from} – ${to}`);
    assert.equal(hasSupplierWeekendDelivery("forum-auto", from, to), expected, `${from} – ${to}`);
  }
  for (const date of [null, undefined, "", "2026-10-16", "2026-10-19", "2026-02-30", "2026-10-17 99:00", "<img src=x>", 0]) {
    assert.equal(hasSupplierWeekendDelivery("part-kom", date), false);
    assert.equal(hasSupplierWeekendDelivery("forum-auto", date), false);
  }
});

test("Forum Auto highlights weekend offers but keeps weekday day-after-tomorrow unhighlighted", () => {
  const monday = new Date(2026, 9, 12, 12).getTime();
  assert.equal(hasOfferDeliveryWarning("forum-auto", "2026-10-14", null, monday), false);
  assert.equal(hasOfferDeliveryWarning("forum-auto", "2026-10-13", null, monday), false);
  assert.equal(hasOfferDeliveryWarning("forum-auto", "2026-10-17", null, monday), true);
  assert.equal(hasOfferDeliveryWarning("forum-auto", "2026-10-16", "2026-10-18", monday), true);
  assert.equal(hasOfferDeliveryWarning("forum-auto", "2026-10-17", "2026-10-20", monday), false);
});

test("Armtek distinguishes unknown periods from a confirmed return prohibition", () => {
  assert.equal(formatArmtekReturnDays(14), "Возврат: 14 дн.");
  assert.equal(formatArmtekReturnDays(0), "Возврат недоступен");
  for (const value of [undefined, null, false, "14", -1, 1.5, Infinity, 10000, {}]) {
    assert.equal(formatArmtekReturnDays(value), "Срок возврата не указан");
  }
});

test("PartKOM offers always highlight the day after tomorrow, but only weekend tomorrows and eligible ranges", () => {
  const now = new Date(2026, 9, 12, 12).getTime();
  for (const [from, to, expected] of [
    ["2026-10-14", null, true],
    ["2026-10-14 09:30:00", "2026-10-14 18:00:00", true],
    ["2026-10-13", null, false],
    ["2026-10-12", null, false],
    ["2026-10-15", null, false],
    ["2026-10-14", "2026-10-15", false],
    ["2026-10-17", "2026-10-20", false],
    ["2026-10-16", "2026-10-18", true],
    ["2026-10-17", null, true],
    [null, null, false],
    ["invalid", null, false],
    ["2026-02-30", null, false],
    ["2026-10-14", "invalid", false],
  ]) {
    assert.equal(hasOfferDeliveryWarning("part-kom", from, to, now), expected, `${from} – ${to}`);
    assert.equal(hasOfferDeliveryWarning("armtek", from, to, now), false);
  }
  const friday = new Date(2026, 9, 16, 12).getTime();
  assert.equal(hasOfferDeliveryWarning("part-kom", "2026-10-17", null, friday), true);
  assert.equal(hasOfferDeliveryWarning("part-kom", "2026-10-14", null, NaN), false);
});
