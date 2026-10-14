import assert from "node:assert/strict";
import { test } from "node:test";
import { tabIdsToClose } from "../src/frontend/tab-close-menu.js";

test("tab closing commands use the context tab and supplied visible order", () => {
  const tabs = [{ id: "left" }, { id: "selected" }, { id: "right" }, { id: "last" }];
  const before = structuredClone(tabs);
  assert.deepEqual(tabIdsToClose(tabs, "selected", "current"), ["selected"]);
  assert.deepEqual(tabIdsToClose(tabs, "selected", "others"), ["left", "right", "last"]);
  assert.deepEqual(tabIdsToClose(tabs, "selected", "left"), ["left"]);
  assert.deepEqual(tabIdsToClose(tabs, "selected", "right"), ["right", "last"]);
  assert.deepEqual(tabIdsToClose(tabs, "left", "left"), []);
  assert.deepEqual(tabIdsToClose(tabs, "last", "right"), []);
  assert.deepEqual(tabIdsToClose(tabs, "missing", "others"), []);
  assert.deepEqual(tabIdsToClose(tabs, "selected", "invalid"), []);
  assert.deepEqual(tabIdsToClose([], "selected", "others"), []);
  assert.deepEqual(tabIdsToClose([tabs[1]], "selected", "others"), []);
  assert.deepEqual(tabs, before);
});
