import { additionalArticleVariants } from "../article-search-variants.ts";
import { NomenclatureError, objectFields, parseUuid } from "../nomenclature/contract.ts";
import { ambiguousOrderPosition, type OrderHistoryItem } from "./order-history-contract.ts";
import { historyDate } from "./order-history-values.ts";

export interface ReconciliationItem {
  article: string;
  brand: string;
  title: string;
  quantity: number;
}

interface LocalReconciliationItem extends ReconciliationItem { brandAliases: string }
interface ReconciliationCounterparty { id: string | null; name: string; items: LocalReconciliationItem[] }
type ReconciliationInput = { from: string; to: string; counterparties: ReconciliationCounterparty[] }
  & ({ all: true } | { all: false; counterpartyId: string });

function invalidInput(): never {
  throw new NomenclatureError(400, "invalid_reconciliation", "Некорректные данные сверки заказа поставщику.");
}

export const reconciliationBodyLimit = 6 * 1024 * 1024;
const reconciliationItemLimit = 6000;

export function parseReconciliation(value: unknown): ReconciliationInput {
  const data = objectFields(value, ["counterpartyId", "from", "to", "items", "counterparties"]);
  const { from, to } = data;
  if (typeof from !== "string" || typeof to !== "string" || from.length !== 10 || to.length !== 10
    || historyDate(from) !== from || historyDate(to) !== to || from > to
    || Date.parse(to) - Date.parse(from) > 92 * 86_400_000) {
    throw new NomenclatureError(400, "invalid_period", "Укажите период сверки от одного до 93 дней.");
  }
  const string = (input: unknown, limit: number) => {
    if (typeof input !== "string" || input.length > limit) invalidInput();
    return input.trim();
  };
  let count = 0;
  const parseItems = (items: unknown, limit: number): LocalReconciliationItem[] => {
    if (!Array.isArray(items) || (count += items.length) > limit) invalidInput();
    return items.map((value: unknown) => {
      const { article, brand, title, quantity, brandAliases } = objectFields(value, ["article", "brand", "title", "quantity", "brandAliases"]);
      if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity < 0 || quantity > 1e12) invalidInput();
      return { article: string(article, 200), brand: string(brand, 200), title: string(title, 500), quantity,
        brandAliases: string(brandAliases, 500) };
    });
  };
  if (!Object.hasOwn(data, "counterparties")) {
    const id = parseUuid(data.counterpartyId);
    return { all: false, counterpartyId: id, from, to, counterparties: [{ id, name: "", items: parseItems(data.items, 2000) }] };
  }
  if (Object.hasOwn(data, "items") || Object.hasOwn(data, "counterpartyId") || !Array.isArray(data.counterparties)
    || data.counterparties.length > reconciliationItemLimit) invalidInput();
  const ids = new Set<string | null>();
  const counterparties = data.counterparties.map((value: unknown) => {
    const entry = objectFields(value, ["id", "name", "items"]);
    const id = entry.id === null ? null : parseUuid(entry.id);
    if (ids.has(id)) invalidInput();
    ids.add(id);
    return { id, name: string(entry.name, 500), items: parseItems(entry.items, reconciliationItemLimit) };
  });
  return { all: true, from, to, counterparties };
}

const compact = (value: string) => value.toUpperCase().replace(/[^\p{L}\p{N}]/gu, "");

function articleKey(article: string): string {
  let key = compact(article);
  for (const variant of additionalArticleVariants(article)) {
    const alternative = compact(variant.article);
    if (alternative < key) key = alternative;
  }
  return key;
}

interface ReconciliationRow {
  status: "shortage" | "extra" | "unverified";
  article: string;
  brand: string;
  title: string;
  onec: number;
  confirmed: number;
  possible: number;
  cancelled: number;
  reason: string;
}

interface ComparisonGroup {
  label: ReconciliationItem;
  exactArticle: string | null;
  onec: number;
  confirmed: number;
  possible: number;
  cancelled: number;
  hasSupplierItem: boolean;
  hasOnecItem: boolean;
  ambiguous: boolean;
}

function supplierQuantity(item: OrderHistoryItem) {
  const { quantity, fulfillment, fulfillmentQuantities } = item;
  const cancelled = fulfillment === "cancelled" ? quantity : item.cancelledQuantity ?? fulfillmentQuantities?.cancelled ?? 0;
  const possible = Math.max(0, quantity - cancelled);
  const confirmed = fulfillment === "unknown" || (fulfillment === "partial" && cancelled === 0)
    || (fulfillment === "partially_cancelled" && cancelled === 0) ? Math.min(possible, item.deliveredQuantity ?? 0) : possible;
  return { confirmed, possible, cancelled };
}

export function compareReconciliation(onecItems: LocalReconciliationItem[], supplierItems: OrderHistoryItem[],
  complete: boolean, { matchPartKomArticle = false, incompleteReason = "Недостаточно данных поставщика." } = {}): ReconciliationRow[] {
  const aliases = new Map<string, string | null>();
  for (const item of onecItems) {
    const key = compact(item.brand);
    if (!key) continue;
    for (const name of [item.brand, ...item.brandAliases.split(/[,;\r\n]+/u)]) {
      const alias = compact(name);
      if (alias) aliases.set(alias, aliases.has(alias) && aliases.get(alias) !== key ? null : key);
    }
  }

  const articles = new Map<string, Map<string, ComparisonGroup>>();
  const ambiguousArticles = new Set<string>();
  const rows: ReconciliationRow[] = [];
  let onecWithoutArticle = false;
  let supplierWithoutArticle = false;
  function groupFor(article: string, brand: string, label: ReconciliationItem) {
    let groups = articles.get(article);
    if (!groups) articles.set(article, groups = new Map());
    let group = groups.get(brand);
    if (!group) groups.set(brand, group = { label, exactArticle: matchPartKomArticle ? compact(label.article) : null,
      onec: 0, confirmed: 0, possible: 0, cancelled: 0, hasOnecItem: false, hasSupplierItem: false, ambiguous: false });
    else if (group.exactArticle && group.exactArticle !== compact(label.article)) group.exactArticle = null;
    return group;
  }

  for (const item of onecItems) {
    const article = articleKey(item.article);
    if (!article) {
      onecWithoutArticle ||= item.quantity > 0;
      rows.push({ status: "unverified", article: item.article, brand: item.brand, title: item.title,
        onec: item.quantity, confirmed: 0, possible: 0, cancelled: 0, reason: "В строке 1С нет артикула." });
      continue;
    }
    const group = groupFor(article, compact(item.brand), item);
    group.hasOnecItem = true;
    group.onec += item.quantity;
  }

  for (const item of supplierItems) {
    const article = articleKey(item.article);
    const brand = compact(item.brand ?? "");
    const quantity = supplierQuantity(item);
    if (!article) {
      supplierWithoutArticle ||= quantity.possible > 0;
      rows.push({ status: "unverified", article: item.article, brand: item.brand ?? "", title: item.title ?? "",
        onec: 0, ...quantity, reason: "Поставщик не указал артикул." });
      continue;
    }
    const alias = aliases.get(brand);
    if (alias === null) ambiguousArticles.add(article);
    const group = groupFor(article, alias ?? brand, { article: item.article, brand: item.brand ?? "", title: item.title ?? "", quantity: 0 });
    group.hasSupplierItem = true;
    group.ambiguous ||= item[ambiguousOrderPosition] === true;
    group.confirmed += quantity.confirmed;
    group.possible += quantity.possible;
    group.cancelled += quantity.cancelled;
  }

  const epsilon = 1e-8;
  for (const [article, groups] of articles) {
    // PartKOM can label a locally recorded article with a different brand. Only match a single candidate on each side.
    if (matchPartKomArticle && groups.size === 2 && !groups.has("") && !ambiguousArticles.has(article)) {
      const onec = [...groups.values()].find((group) => group.hasOnecItem && !group.hasSupplierItem);
      const remote = [...groups].find(([, group]) => group.hasSupplierItem && !group.hasOnecItem);
      if (onec?.exactArticle && remote && !remote[1].ambiguous && onec.exactArticle === remote[1].exactArticle) {
        onec.confirmed = remote[1].confirmed;
        onec.possible = remote[1].possible;
        onec.cancelled = remote[1].cancelled;
        groups.delete(remote[0]);
      }
    }
    const withoutBrand = groups.get("");
    let missingBrand = false;
    if (withoutBrand) {
      for (const group of groups.values()) {
        missingBrand ||= withoutBrand.hasOnecItem && group.hasSupplierItem || withoutBrand.hasSupplierItem && group.hasOnecItem;
      }
    }
    for (const { label, onec, confirmed, possible, cancelled, ambiguous } of groups.values()) {
      let status: ReconciliationRow["status"];
      let reason: string;
      if (missingBrand || ambiguous || ambiguousArticles.has(article)) {
        status = "unverified";
        reason = missingBrand ? "Нужно уточнить бренд у одного из товаров с этим артикулом." : "Неоднозначные данные о позиции.";
      } else if (onec - possible > epsilon) {
        status = complete && !supplierWithoutArticle ? "shortage" : "unverified";
        reason = status === "unverified" ? supplierWithoutArticle ? "В истории есть позиции без артикула." : incompleteReason
          : cancelled > 0 ? "Есть отменённое количество." : "У поставщика меньше, чем указано в 1С.";
      } else if (confirmed - onec > epsilon) {
        status = onecWithoutArticle ? "unverified" : "extra";
        reason = onecWithoutArticle ? "В 1С есть строки без артикула." : "В 1С за период учтено меньше, чем заказано у поставщика.";
      } else if (possible - confirmed > epsilon) {
        status = "unverified";
        reason = "Статус позиции у поставщика не подтверждает всё количество.";
      } else continue;
      rows.push({ status, article: label.article, brand: label.brand, title: label.title, onec, confirmed, possible, cancelled, reason });
    }
  }
  return rows;
}
