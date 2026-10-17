import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateMarkupPrice, markupPercentForPrice, restoreMarkupSettings, showPurchasePrice, validateMarkupSettings } from "../src/frontend/markup-settings.js";

test("markup migrates legacy per-tab percentages without losing the former display defaults", () => {
  assert.deepEqual(restoreMarkupSettings(undefined, 17), { mode: "fixed", percent: 17, fallbackPercent: 17, tiers: [], display: "both", showPurchaseInCart: true });
  assert.equal(restoreMarkupSettings().percent, 35);
  assert.equal(restoreMarkupSettings(undefined, "12.5").percent, 12.5);
  assert.equal(restoreMarkupSettings(undefined, -8).percent, 0);
  assert.equal(restoreMarkupSettings(undefined, 2000).percent, 1000);
  for (const corrupt of [null, [], "bad", { mode: "fixed" }, { ...restoreMarkupSettings(), percent: Infinity }]) {
    assert.equal(restoreMarkupSettings(corrupt, 19).percent, 19);
  }
});

test("tiered markup uses inclusive purchase-price thresholds, ordered independently of entry order", () => {
  const settings = validateMarkupSettings({ ...restoreMarkupSettings(), mode: "tiered", fallbackPercent: 10,
    tiers: [{ upTo: 3000, percent: 15 }, { upTo: 500, percent: 25 }, { upTo: 1000, percent: 20 }] });
  assert.deepEqual(settings.tiers.map((tier) => tier.upTo), [500, 1000, 3000]);
  for (const [price, percent] of [[1, 25], [500, 25], [500.01, 20], [1000, 20], [1000.01, 15], [3000, 15], [3000.01, 10]]) {
    assert.equal(markupPercentForPrice(price, settings), percent);
    assert.equal(calculateMarkupPrice(price, settings), price * (1 + percent / 100));
  }
  const prices = [500, 501].map((price) => calculateMarkupPrice(price, settings));
  assert.ok(prices[1] < prices[0], "retail sorting must use the calculated price rather than the purchase price");
  assert.ok(Math.abs(calculateMarkupPrice(100, { ...settings, tiers: [], fallbackPercent: 12 }) - 112) < 1e-10);
});

test("markup rejects malformed tiers and preferences at the local-state boundary", () => {
  const base = restoreMarkupSettings();
  for (const change of [{ mode: "unknown" }, { percent: "20" }, { percent: -1 }, { percent: 1001 }, { percent: NaN },
    { fallbackPercent: Infinity }, { display: "html" }, { showPurchaseInCart: "false" }, { tiers: {} },
    { tiers: [null] }, { tiers: [{ upTo: 0, percent: 20 }] }, { tiers: [{ upTo: "500", percent: 20 }] },
    { tiers: [{ upTo: Infinity, percent: 20 }] }, { tiers: [{ upTo: 500, percent: -1 }] },
    { tiers: [{ upTo: 500, percent: 10 }, { upTo: 500, percent: 20 }] },
    { tiers: Array.from({ length: 31 }, (_, index) => ({ upTo: index + 1, percent: 10 })) }]) {
    assert.throws(() => validateMarkupSettings({ ...base, ...change }));
  }
  for (const price of [undefined, null, "100", -1, 0, NaN, Infinity, Number.MAX_VALUE]) assert.equal(calculateMarkupPrice(price, base), null);
});

test("no markup and display preferences hide duplicate purchase prices consistently", () => {
  const settings = restoreMarkupSettings();
  assert.equal(calculateMarkupPrice(100, settings), 135);
  assert.equal(calculateMarkupPrice(100, { ...settings, mode: "none" }), 100);
  assert.equal(calculateMarkupPrice(100, { ...settings, percent: 0 }), 100);
  assert.equal(showPurchasePrice(settings), true);
  assert.equal(showPurchasePrice(settings, true), true);
  assert.equal(showPurchasePrice({ ...settings, showPurchaseInCart: false }), true);
  assert.equal(showPurchasePrice({ ...settings, showPurchaseInCart: false }, true), false);
  for (const change of [{ mode: "none" }, { display: "retail" }]) {
    assert.equal(showPurchasePrice({ ...settings, ...change }), false);
    assert.equal(showPurchasePrice({ ...settings, ...change }, true), false);
  }
});
