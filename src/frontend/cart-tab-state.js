const validId = (value) => typeof value === "string" && /^[0-9a-f-]{36}$/.test(value);
const validTabId = (value) => typeof value === "string" && /^custom-[0-9a-f-]{36}$/.test(value);

export const normalizeCartTabs = (value) => {
  if (value?.version !== 1 || !Array.isArray(value.tabs)) return [];
  const tabIds = new Set();
  const itemIds = new Set();
  return value.tabs.slice(0, 100).flatMap((tab) => {
    if (!tab || !validTabId(tab.id) || tabIds.has(tab.id) || typeof tab.name !== "string"
      || !tab.name.trim() || tab.name.length > 100 || !Array.isArray(tab.itemIds)) return [];
    tabIds.add(tab.id);
    return [{ id: tab.id, name: tab.name.trim(), excludeFromAll: tab.excludeFromAll === true,
      itemIds: tab.itemIds.slice(0, 500).filter((id) => {
        if (!validId(id) || itemIds.has(id)) return false;
        itemIds.add(id);
        return true;
      }) }];
  });
};

export const cartTabItems = (items, tabs, tabId) => {
  const custom = tabs.find((tab) => tab.id === tabId);
  if (custom) {
    const ids = new Set(custom.itemIds);
    return items.filter((item) => ids.has(item.id));
  }
  if (tabId !== "all") return items.filter((item) => item.result.supplier === tabId);
  const hidden = new Set(tabs.filter((tab) => tab.excludeFromAll).flatMap((tab) => tab.itemIds));
  return items.filter((item) => !hidden.has(item.id));
};

export const moveCartItems = (tabs, itemIds, targetId) => {
  const moved = new Set(itemIds);
  return tabs.map((tab) => ({ ...tab,
    itemIds: [...tab.itemIds.filter((id) => !moved.has(id)), ...(tab.id === targetId ? moved : [])],
  }));
};

export const moveCartItem = (tabs, itemId, targetId) => moveCartItems(tabs, [itemId], targetId);

export const reorderCartTab = (tabs, sourceId, targetId, after = false) => {
  const source = tabs.find((tab) => tab.id === sourceId);
  if (!source || sourceId === targetId || !tabs.some((tab) => tab.id === targetId)) return tabs;
  const result = tabs.filter((tab) => tab.id !== sourceId);
  result.splice(result.findIndex((tab) => tab.id === targetId) + Number(after), 0, source);
  return result;
};
