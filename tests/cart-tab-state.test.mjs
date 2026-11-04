import assert from "node:assert/strict";
import { test } from "node:test";
import { cartTabItems, moveCartItem, normalizeCartTabs, reorderCartTab } from "../src/frontend/cart-tab-state.js";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tab = (n, itemIds = [], excludeFromAll = false) => ({ id: `custom-${id(n)}`, name: `Вкладка ${n}`, itemIds, excludeFromAll });
const items = [1, 2, 3].map((n) => ({ id: id(n), quantity: n, result: { supplier: n === 2 ? "part-kom" : "armtek" } }));

test("cart tab storage validates untrusted state and deduplicates membership without losing empty tabs", () => {
  for (const value of [null, false, [], {}, { version: 2, tabs: [tab(1)] }]) assert.deepEqual(normalizeCartTabs(value), []);
  const name = '<img src=x onerror="window.tabXss=1">';
  const result = normalizeCartTabs({ version: 1, tabs: [null, { ...tab(1), id: "all" }, { ...tab(1), name: " " },
    { ...tab(1, [id(1), id(1), "bad", null]), name }, tab(1), tab(2, [id(1), id(2)]), tab(3),
    { ...tab(4), name: "x".repeat(101) }, { ...tab(5), excludeFromAll: "true" }] });
  assert.deepEqual(result, [{ ...tab(1, [id(1)]), name }, tab(2, [id(2)]), tab(3), tab(5)]);
});

test("excluding a custom cart tab affects only All; supplier filters and custom tabs retain their real items", () => {
  const tabs = [tab(1, [id(1), id(2)], true), tab(2, [id(3)])];
  assert.deepEqual(cartTabItems(items, tabs, "all"), [items[2]]);
  assert.deepEqual(cartTabItems(items, tabs, tabs[0].id), items.slice(0, 2));
  assert.deepEqual(cartTabItems(items, tabs, "armtek"), [items[0], items[2]]);
  assert.deepEqual(cartTabItems(items, tabs, "part-kom"), [items[1]]);
  assert.deepEqual(cartTabItems(items, tabs.slice(1), "all"), items, "closing a tab restores its hidden goods");
});

test("moving a cart item replaces membership and returning to All removes it from custom tabs", () => {
  const tabs = [tab(1, [id(1)], true), tab(2, [id(2)])];
  const moved = moveCartItem(tabs, id(1), tabs[1].id);
  assert.deepEqual(moved, [tab(1, [], true), tab(2, [id(2), id(1)])]);
  assert.deepEqual(tabs[0].itemIds, [id(1)], "the original state is not mutated");
  assert.deepEqual(cartTabItems(items, moved, "all"), items);
  assert.deepEqual(moveCartItem(moved, id(1), "all"), [tab(1, [], true), tab(2, [id(2)])]);
});

test("custom cart tabs reorder on either side while retaining names, hidden flags and goods", () => {
  const tabs = [tab(1, [id(1)], true), tab(2, [id(2)]), tab(3)];
  assert.deepEqual(reorderCartTab(tabs, tabs[2].id, tabs[0].id), [tabs[2], tabs[0], tabs[1]]);
  assert.deepEqual(reorderCartTab(tabs, tabs[0].id, tabs[2].id, true), [tabs[1], tabs[2], tabs[0]]);
  for (const [source, target] of [["all", tabs[0].id], [tabs[0].id, "armtek"], [tabs[0].id, tabs[0].id]]) {
    assert.equal(reorderCartTab(tabs, source, target), tabs);
  }
});
