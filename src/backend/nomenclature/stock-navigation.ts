import { NomenclatureError, objectFields, parseUuid } from "./contract.ts";

export interface StockTreeItem { id: string; name: string; parentId: string | null; isFolder: boolean }
export interface StockNavigation { categories: StockTreeItem[]; groups: StockTreeItem[]; oemBrands: { id: string; name: string }[] }
export function parseStockNavigation(value: unknown): StockNavigation {
  const data = objectFields(value, ["categories", "groups", "oemBrands"]);
  const list = (value: unknown, tree: boolean) => {
    if (!Array.isArray(value) || value.length > 5000) throw new NomenclatureError(400, "invalid_stock_navigation", "Некорректные категории номенклатуры.");
    const ids = new Set<string>();
    const items = value.map((value) => {
      const item = objectFields(value, tree ? ["id", "name", "parentId", "isFolder"] : ["id", "name"]);
      const id = parseUuid(item.id);
      if (ids.has(id) || typeof item.name !== "string" || !item.name.trim() || item.name.length > 150 || /[\u0000-\u001f\u007f-\u009f]/.test(item.name)
        || tree && typeof item.isFolder !== "boolean") throw new NomenclatureError(400, "invalid_stock_navigation", "Некорректная группа номенклатуры.");
      ids.add(id);
      return { id, name: item.name.trim(), parentId: tree && item.parentId !== null ? parseUuid(item.parentId) : null, isFolder: tree && item.isFolder === true };
    });
    const parents = new Map(items.map((item) => [item.id, item.parentId]));
    const checked = new Set<string>();
    for (const item of items) {
      const path = new Set<string>();
      let id: string | null = item.id;
      while (id && parents.has(id) && !checked.has(id)) {
        if (path.has(id)) throw new NomenclatureError(400, "invalid_stock_navigation", "Цикл в группах номенклатуры.");
        path.add(id); id = parents.get(id)!;
      }
      for (const id of path) checked.add(id);
    }
    return items;
  };
  return { categories: list(data.categories, true), groups: list(data.groups, true), oemBrands: list(data.oemBrands, false).map(({ id, name }) => ({ id, name })) };
}
