import { normalizeApplicabilitySku, parseApplicabilitySkus } from "./applicability-search-input.js";

export const searchHistoryLimit = 100;
export const searchHistoryStorageKeys = {
  pricing: "autoservice.searchHistory",
  applicability: "autoservice.applicabilitySearchHistory",
};

const normalizeEntry = (entry, kind) => {
  if (!entry || typeof entry.query !== "string") return null;
  const query = entry.query.trim();
  if (!query || query.length > (kind === "applicability" ? 8192 : 128) || /[\u0000-\u001f\u007f]/.test(query)) return null;
  if (kind !== "applicability") return { query, brands: [] };
  try {
    if (!parseApplicabilitySkus(query).length) return null;
  } catch {
    return null; // Corrupt saved queries must not prevent the search form from opening.
  }
  if (!Array.isArray(entry.brands) || !entry.brands.length || entry.brands.length > 500
    || entry.brands.some((brand) => typeof brand !== "string" || !brand.trim() || brand.length > 128 || /[\u0000-\u001f\u007f]/.test(brand))) return null;
  const brands = [...new Map(entry.brands.map((brand) => [brand.trim().toLocaleUpperCase(), brand.trim()])).values()];
  return { query, brands };
};

const identity = (entry, kind) => JSON.stringify([
  kind === "applicability"
    ? parseApplicabilitySkus(entry.query).map((sku) => normalizeApplicabilitySku(sku).toLocaleUpperCase()).sort()
    : entry.query.toLocaleUpperCase(),
  entry.brands.map((brand) => brand.toLocaleUpperCase()).sort(),
]);

export function normalizeSearchHistory(value, kind) {
  if (!Array.isArray(value)) return [];
  const entries = new Map();
  for (const raw of value.slice(0, 1000)) {
    const entry = normalizeEntry(raw, kind);
    if (!entry) continue;
    const key = identity(entry, kind);
    if (!entries.has(key)) entries.set(key, entry);
    if (entries.size === searchHistoryLimit) break;
  }
  return [...entries.values()];
}

export function addSearchHistoryEntry(history, entry, kind) {
  return normalizeSearchHistory([entry, ...history], kind);
}
