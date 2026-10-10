import assert from "node:assert/strict";
import { test } from "node:test";
import { moveApplicabilityGroupRelative, moveApplicabilityTabIntoGroup, moveApplicabilityTabOutOfGroup, moveApplicabilityTabRelative, nextApplicabilityGroupNumber, normalizeApplicabilityGroupName, restoreApplicabilityGroups } from "../src/frontend/applicability-tab-groups.js";

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

test("dragging out moves only the selected tab to the end and retains search objects", () => {
  const searches = [{ sku: "FIXTURE", results: [] }];
  const source = { id: "a", groupId: "g1", searches };
  const tabs = [source, { id: "b", groupId: "g1" }, { id: "c", groupId: "g2" }];
  const groups = [{ id: "g1", name: "Группа 1" }, { id: "g2", name: "Группа 2" }];
  assert.equal(moveApplicabilityTabOutOfGroup(tabs, groups, "a"), true);
  assert.equal(source.groupId, null);
  assert.equal(source.searches, searches);
  assert.deepEqual(tabs.map((tab) => tab.id), ["b", "c", "a"]);
  assert.equal(tabs[0].groupId, "g1");
  assert.equal(groups.length, 2);
  assert.equal(moveApplicabilityTabOutOfGroup(tabs, groups, "b"), true);
  assert.deepEqual(groups, [{ id: "g2", name: "Группа 2" }]);
  assert.deepEqual(tabs.map((tab) => tab.id), ["c", "a", "b"]);
});

test("dragging out an unknown or ungrouped tab leaves tabs and folders unchanged", () => {
  const tabs = [{ id: "a", groupId: null }, { id: "b", groupId: "g1" }];
  const groups = [{ id: "g1", name: "Группа 1" }];
  const snapshot = structuredClone({ tabs, groups });
  assert.equal(moveApplicabilityTabOutOfGroup(tabs, groups, "a"), false);
  assert.equal(moveApplicabilityTabOutOfGroup(tabs, groups, "missing"), false);
  assert.deepEqual({ tabs, groups }, snapshot);
});

test("moving tabs relative to each other reorders them and adopts the target group", () => {
  const tabs = [{ id: "a", groupId: null }, { id: "b", groupId: "g1" }, { id: "c", groupId: "g1" }, { id: "d", groupId: null }];
  const groups = [{ id: "g1", name: "Группа 1" }];
  assert.equal(moveApplicabilityTabRelative(tabs, groups, "c", "b", "before"), true);
  assert.deepEqual(tabs.map((tab) => tab.id), ["a", "c", "b", "d"]);
  assert.equal(moveApplicabilityTabRelative(tabs, groups, "a", "d", "after"), true);
  assert.deepEqual(tabs.map((tab) => tab.id), ["c", "b", "d", "a"]);
  assert.equal(tabs.at(-1).groupId, null);
  assert.deepEqual(groups, [{ id: "g1", name: "Группа 1" }]);
});

test("moving groups reorders their tab blocks and group persistence order", () => {
  const tabs = [{ id: "a", groupId: "g1" }, { id: "b", groupId: "g2" }, { id: "c", groupId: "g1" }, { id: "d", groupId: "g2" }];
  const groups = [{ id: "g1", name: "Группа 1" }, { id: "g2", name: "Группа 2" }];
  assert.equal(moveApplicabilityGroupRelative(tabs, groups, "g2", "a", "before"), true);
  assert.deepEqual(tabs.map((tab) => tab.id), ["b", "d", "a", "c"]);
  assert.deepEqual(groups.map((group) => group.id), ["g2", "g1"]);
  assert.equal(moveApplicabilityGroupRelative(tabs, groups, "g1", "b", "after"), true);
  assert.deepEqual(tabs.map((tab) => tab.id), ["b", "d", "a", "c"]);
});

test("moving a group past standalone tabs preserves member order and objects", () => {
  const searches = [{ sku: "TEST" }];
  const tabs = [{ id: "left", groupId: null }, { id: "a", groupId: "g", searches }, { id: "b", groupId: "g" }, { id: "right", groupId: null }];
  const groups = [{ id: "g", name: "Группа 1" }];
  assert.equal(moveApplicabilityGroupRelative(tabs, groups, "g", "left", "before"), true);
  assert.deepEqual(tabs.map((tab) => tab.id), ["a", "b", "left", "right"]);
  assert.equal(moveApplicabilityGroupRelative(tabs, groups, "g", "right", "after"), true);
  assert.deepEqual(tabs.map((tab) => tab.id), ["left", "right", "a", "b"]);
  assert.equal(tabs.find((tab) => tab.id === "a").searches, searches);
  const snapshot = structuredClone({ tabs, groups });
  for (const [source, target] of [["g", "a"], ["g", "missing"], ["missing", "right"]]) {
    assert.equal(moveApplicabilityGroupRelative(tabs, groups, source, target), false);
  }
  assert.deepEqual({ tabs, groups }, snapshot);
});
