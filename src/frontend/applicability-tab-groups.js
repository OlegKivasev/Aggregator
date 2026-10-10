export const normalizeApplicabilityGroupName = (value) => typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, 100) : "";

export function restoreApplicabilityGroups(value, tabs) {
  const groups = new Map();
  if (Array.isArray(value)) {
    for (const group of value) {
      if (!group || typeof group.id !== "string" || !group.id.trim() || group.id.length > 128 || /[\u0000-\u001f\u007f]/u.test(group.id)) continue;
      const name = normalizeApplicabilityGroupName(group.name);
      if (name && !groups.has(group.id)) groups.set(group.id, { id: group.id, name });
    }
  }
  tabs.forEach((tab) => { if (!groups.has(tab.groupId)) tab.groupId = null; });
  return [...groups.values()].filter((group) => tabs.some((tab) => tab.groupId === group.id));
}

export function nextApplicabilityGroupNumber(value, groups) {
  const largest = groups.reduce((maximum, group) => {
    const number = /^Группа (\d+)$/u.exec(group.name)?.[1];
    return number && Number(number) <= 1_000_000 ? Math.max(maximum, Number(number)) : maximum;
  }, 0);
  return Math.max(Number.isSafeInteger(value) && value > 0 && value <= 1_000_000 ? value : 1, largest + 1);
}

export function moveApplicabilityTabIntoGroup(tabs, groups, sourceId, targetId, createGroup) {
  const source = tabs.find((tab) => tab.id === sourceId);
  const target = tabs.find((tab) => tab.id === targetId);
  if (!source || !target || source === target || (target.groupId && source.groupId === target.groupId)) return null;
  let group = groups.find((item) => item.id === target.groupId);
  if (!group) {
    group = createGroup();
    groups.push(group);
    target.groupId = group.id;
  }
  source.groupId = group.id;
  tabs.splice(tabs.indexOf(source), 1);
  const lastMember = tabs.findLastIndex((tab) => tab.groupId === group.id);
  tabs.splice(lastMember + 1, 0, source);
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    if (!tabs.some((tab) => tab.groupId === groups[index].id)) groups.splice(index, 1);
  }
  return group;
}

export function moveApplicabilityTabOutOfGroup(tabs, groups, sourceId) {
  const source = tabs.find((tab) => tab.id === sourceId);
  if (!source?.groupId) return false;
  source.groupId = null;
  tabs.splice(tabs.indexOf(source), 1);
  tabs.push(source);
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    if (!tabs.some((tab) => tab.groupId === groups[index].id)) groups.splice(index, 1);
  }
  return true;
}

export function moveApplicabilityTabRelative(tabs, groups, sourceId, targetId, position = "before") {
  const source = tabs.find((tab) => tab.id === sourceId);
  const target = tabs.find((tab) => tab.id === targetId);
  if (!source || !target || source === target) return false;
  source.groupId = target.groupId ?? null;
  tabs.splice(tabs.indexOf(source), 1);
  const targetIndex = tabs.indexOf(target);
  tabs.splice(position === "after" ? targetIndex + 1 : targetIndex, 0, source);
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    if (!tabs.some((tab) => tab.groupId === groups[index].id)) groups.splice(index, 1);
  }
  return true;
}

export function moveApplicabilityGroupRelative(tabs, groups, sourceGroupId, targetTabId, position = "before") {
  const source = groups.find((group) => group.id === sourceGroupId);
  const target = tabs.find((tab) => tab.id === targetTabId);
  if (!source || !target || target.groupId === source.id) return false;
  const members = tabs.filter((tab) => tab.groupId === source.id);
  const remaining = tabs.filter((tab) => tab.groupId !== source.id);
  const targetMembers = target.groupId ? remaining.filter((tab) => tab.groupId === target.groupId) : [target];
  if (!members.length || !targetMembers.length) return false;
  const targetIndex = remaining.indexOf(position === "after" ? targetMembers.at(-1) : targetMembers[0]);
  remaining.splice(position === "after" ? targetIndex + 1 : targetIndex, 0, ...members);
  tabs.splice(0, tabs.length, ...remaining);
  groups.sort((left, right) => tabs.findIndex((tab) => tab.groupId === left.id) - tabs.findIndex((tab) => tab.groupId === right.id));
  return true;
}
