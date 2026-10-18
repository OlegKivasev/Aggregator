import assert from "node:assert/strict";
import { test } from "node:test";
import { deliveryCalendarDay, isOfferDueSoon } from "../src/frontend/delivery-dates.js";

test("near-term offers include tomorrow and the following day with a weekday-tomorrow exception for PartKOM", () => {
  const now = new Date(2026, 9, 12, 23, 30).getTime();
  const date = (day) => new Date(2026, 9, day, 12).toISOString();
  const offer = (from, to = null, supplier = "armtek") => ({ supplier, deliveryDate: from, deliveryDateTo: to });
  for (const supplier of ["armtek", "forum-auto", "rossko"]) {
    for (const day of [13, 14]) assert.equal(isOfferDueSoon(offer(date(day), null, supplier), now), true);
  }
  assert.equal(isOfferDueSoon(offer(date(13), date(14)), now), true);
  assert.equal(isOfferDueSoon({ ...offer(date(14)), deliveryDateApproximate: true }, now), false);
  assert.equal(isOfferDueSoon(offer(date(13), null, "part-kom"), now), true);
  assert.equal(isOfferDueSoon(offer(date(13), date(13), "part-kom"), now), true);
  for (const value of [
    offer(date(12)), offer(date(15)), offer(date(11)), offer(date(12), date(14)), offer(date(13), date(15)),
    offer(date(14), date(13)), offer(date(13), date(14), "part-kom"), offer(date(14), null, "part-kom"),
    offer(null), offer("invalid"), offer("2026-02-30"), offer(date(13), "invalid"), null, {},
  ]) assert.equal(isOfferDueSoon(value, now), false, JSON.stringify(value));
  assert.equal(isOfferDueSoon(offer(date(13)), NaN), false);
});

test("near-term delivery excludes approximate tomorrow, the following day and ranges for every supplier", () => {
  const now = new Date(2026, 9, 12, 12).getTime();
  for (const supplier of ["armtek", "part-kom", "forum-auto", "rossko"]) {
    for (const [deliveryDate, deliveryDateTo] of [["2026-10-13", null], ["2026-10-14", null], ["2026-10-13", "2026-10-14"]]) {
      const offer = { supplier, deliveryDate, deliveryDateTo, deliveryDateApproximate: true };
      assert.equal(isOfferDueSoon(offer, now), false, JSON.stringify(offer));
      assert.equal(offer.deliveryDateApproximate, true, "filtering must preserve the offer's delivery data");
    }
  }
});

test("PartKOM near-term delivery allows Friday and Monday but excludes Saturday and Sunday", () => {
  for (const [today, tomorrow, expected] of [[15, 16, true], [16, 17, false], [17, 18, false], [18, 19, true]]) {
    assert.equal(isOfferDueSoon({ supplier: "part-kom", deliveryDate: new Date(2026, 9, tomorrow, 12).toISOString() }, new Date(2026, 9, today, 12).getTime()), expected);
  }
});

test("delivery calendar uses browser days for zoned instants and validates supplier calendar dates", () => {
  const zoned = "2026-10-13T00:30:00+04:00"; const instant = new Date(zoned);
  assert.equal(deliveryCalendarDay(zoned), Date.UTC(instant.getFullYear(), instant.getMonth(), instant.getDate()) / 86_400_000);
  assert.equal(deliveryCalendarDay("2026-10-13 09:30:00"), Date.UTC(2026, 9, 13) / 86_400_000);
  for (const value of [null, undefined, 0, "2026-02-30", "2026-13-01", "2026-10-13 24:00", "2026-10-13T09:00:00+99:00"]) assert.equal(deliveryCalendarDay(value), null);
  const now = new Date(2026, 11, 31, 23, 30).getTime();
  assert.equal(isOfferDueSoon({ supplier: "armtek", deliveryDate: new Date(2027, 0, 1, 12).toISOString(), deliveryDateTo: new Date(2027, 0, 2, 12).toISOString() }, now), true);
});
