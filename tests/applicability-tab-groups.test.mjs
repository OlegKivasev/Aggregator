import assert from "node:assert/strict";
import { test } from "node:test";
import { moveApplicabilityTabIntoGroup, nextApplicabilityGroupNumber, normalizeApplicabilityGroupName, restoreApplicabilityGroups } from "../src/frontend/applicability-tab-groups.js";

test("restoring tab groups migrates old tabs and discards invalid and empty group references", () => {
  const tabs = [{ id: "old" }, { id: "valid", groupId: "group" }, { id: "dangling", groupId: "missing" }];
  const groups = restoreApplicabilityGroups([
    null, 7, { id: "", name: "Empty ID" }, { id: "bad\u0000", name: "Bad ID" },
    { id: "bad-name", name: 9 }, { id: "blank", name: " " }, { id: "unused", name: "Empty group" },
    { id: "group", name: "  Мои   детали  " }, { id: "group", name: "Duplicate" },
  ], tabs);
  assert.deepEqual(groups, [{ id: "group", name: "Мои детали" }]);
  assert.deepEqual(tabs.map((tab) => tab.groupId), [null, "group", null]);
  assert.deepEqual(restoreApplicabilityGroups(null, tabs), []);
  assert.deepEqual(tabs.map((tab) => tab.groupId), [null, null, null]);
});

test("group names and numbering are bounded and continue after saved or renamed groups", () => {
  assert.equal(normalizeApplicabilityGroupName(null), "");
  assert.equal(normalizeApplicabilityGroupName(" A\nB "), "A B");
  assert.equal(normalizeApplicabilityGroupName("Ж".repeat(101)).length, 100);
  assert.equal(nextApplicabilityGroupNumber(undefined, [{ name: "Группа 3" }]), 4);
  assert.equal(nextApplicabilityGroupNumber(9, [{ name: "Переименована" }]), 9);
  assert.equal(nextApplicabilityGroupNumber(-1, [{ name: "Группа 2" }]), 3);
  assert.equal(nextApplicabilityGroupNumber(Number.MAX_SAFE_INTEGER, [{ name: `Группа ${Number.MAX_SAFE_INTEGER}` }]), 1);
});

test("dropping one tab onto another creates a group without altering result objects", () => {
  const results = [{ sku: "FIXTURE" }];
  const source = { id: "a", groupId: null, results };
  const target = { id: "b", groupId: null };
  const tabs = [source, { id: "c", groupId: null }, target];
  const groups = [];
  const group = moveApplicabilityTabIntoGroup(tabs, groups, "a", "b", () => ({ id: "g1", name: "Группа 1" }));
  assert.equal(source.results, results);
  assert.deepEqual(groups, [group]);
  assert.deepEqual(tabs.map((tab) => tab.id), ["c", "b", "a"]);
  assert.equal(source.groupId, "g1");
  assert.equal(target.groupId, "g1");
});

test("moving between groups moves only the dragged tab and prunes empty source groups", () => {
  const tabs = [{ id: "a", groupId: "g1" }, { id: "b", groupId: "g1" }, { id: "c", groupId: "g2" }];
  const groups = [{ id: "g1", name: "Группа 1" }, { id: "g2", name: "Группа 2" }];
  const noNewGroup = () => { throw new Error("must not create another group"); };
  assert.equal(moveApplicabilityTabIntoGroup(tabs, groups, "a", "c", noNewGroup).id, "g2");
  assert.equal(tabs.find((tab) => tab.id === "b").groupId, "g1");
  assert.equal(groups.length, 2);
  moveApplicabilityTabIntoGroup(tabs, groups, "b", "c", noNewGroup);
  assert.deepEqual(groups, [{ id: "g2", name: "Группа 2" }]);
  assert.deepEqual(tabs.map((tab) => tab.id), ["c", "a", "b"]);
});

test("self drops, repeated same-group drops and missing tabs do not mutate groups", () => {
  const tabs = [{ id: "a", groupId: "g1" }, { id: "b", groupId: "g1" }];
  const groups = [{ id: "g1", name: "Группа 1" }];
  const snapshot = structuredClone({ tabs, groups });
  for (const [source, target] of [["a", "a"], ["a", "b"], ["missing", "b"], ["a", "missing"]]) {
    assert.equal(moveApplicabilityTabIntoGroup(tabs, groups, source, target, () => { throw new Error("must not create group"); }), null);
  }
  assert.deepEqual({ tabs, groups }, snapshot);
});
