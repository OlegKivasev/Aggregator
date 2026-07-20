import type { SupplierSessionManager } from "../../session/session-manager.ts";
import type { NormalizedSearchResult, SearchQuery, SupplierSearchContext, SupplierSessionState } from "../../types.ts";
import { SupplierAuthError } from "../errors.ts";
import { siteHttpRequest } from "../site-http.ts";
import type { SupplierAdapter } from "../supplier-adapter.ts";
import { getPartKomCookieHeader, hasPartKomStorageState, partKomApiBaseUrl } from "./part-kom-site-auth.ts";

interface PartKomAutocompleteItem {
  maker?: string;
  maker_id?: string | number;
  number?: string;
  title?: string;
}

interface PartKomAutocompleteResponse {
  success?: boolean;
  msg?: string;
  data?: {
    autocomplete?: PartKomAutocompleteItem[];
    articul?: PartKomAutocompleteItem[];
    parts?: PartKomAutocompleteItem[];
    goods?: PartKomAutocompleteItem[];
  };
}

interface PartKomOffer {
  [key: string]: unknown;
  price?: string | number;
  quantity?: string | number;
  maker_id?: string | number;
  number?: string;
  description?: string;
  name?: string;
  provider_id?: string | number;
  delivery_wave_date_from?: string;
  days_guaranteed?: string | number;
  stock_data?: Record<string, unknown>;
}

interface PartKomPart {
  maker_id?: string | number;
  number?: string;
  description?: string;
  name?: string;
  offers?: PartKomOffer[];
}

interface PartKomProvider {
  id?: string | number;
  store_name?: string;
  city_placement?: string;
}

interface PartKomSearchResponse {
  success?: boolean;
  msg?: string;
  message?: string;
  exact?: PartKomPart[];
  providers?: PartKomProvider[];
  makers?: Array<{ id?: string | number; name?: string }> | Record<string, { id?: string | number; name?: string }>;
}

function normalizeArticle(value: string): string {
  return value.replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

export function findPrimaryPartKomMakerId(items: PartKomAutocompleteItem[], article: string): string | null {
  const target = normalizeArticle(article);
  const item = items.find((candidate) =>
    candidate.maker_id !== undefined && normalizeArticle(candidate.number || "") === target,
  );
  return item ? String(item.maker_id) : null;
}

function parsePrice(value: string | number | undefined): number | null {
  const parsed = typeof value === "number" ? value : Number(value?.replace(/\s+/g, "").replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function dateFromDays(value: string | number | undefined): string | null {
  const raw = String(value ?? "").replace(/[^\d.]/g, "");
  if (!raw) {
    return null;
  }
  const days = Number(raw);
  if (!Number.isFinite(days)) {
    return null;
  }
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + Math.ceil(days)).toISOString();
}

function deliveryDate(value: string | undefined, days: string | number | undefined): string | null {
  if (value) {
    const normalized = value.trim().replace(/^~/, "");
    const match = normalized.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?/);
    if (match) {
      const now = new Date();
      let year = match[3] ? Number(match[3].length === 2 ? `20${match[3]}` : match[3]) : now.getFullYear();
      let result = new Date(year, Number(match[2]) - 1, Number(match[1]));
      if (!match[3] && result.getTime() < now.getTime() - 30 * 86400000) {
        result = new Date(year + 1, Number(match[2]) - 1, Number(match[1]));
      }
      return Number.isNaN(result.getTime()) ? dateFromDays(days) : result.toISOString();
    }
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return dateFromDays(days);
}

function makerName(makers: PartKomSearchResponse["makers"], makerId: string | number | undefined, fallback: string): string {
  const target = String(makerId ?? "");
  const rows = Array.isArray(makers) ? makers : Object.values(makers || {});
  return rows.find((maker) => String(maker.id ?? "") === target)?.name || fallback;
}

function warehouse(offer: PartKomOffer, providers: PartKomProvider[]): string | null {
  const provider = providers.find((item) => String(item.id ?? "") === String(offer.provider_id ?? ""));
  const value = offer.warehouse ?? offer.warehouse_name ?? offer.store_name ?? offer.stock_name ??
    offer.stock_data?.warehouse_name ?? offer.stock_data?.warehouse ?? provider?.store_name ?? provider?.city_placement;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function requestJson<T>(path: string, params: URLSearchParams, signal: AbortSignal): Promise<T> {
  const cookie = getPartKomCookieHeader();
  if (!cookie) {
    throw new SupplierAuthError("Part-Kom stored session is not available");
  }
  const url = new URL(path, partKomApiBaseUrl);
  url.search = params.toString();
  const response = await siteHttpRequest(url, {
    cookie,
    signal,
    headers: { "X-Requested-With": "XMLHttpRequest", Referer: partKomApiBaseUrl },
  });
  if (response.status === 401 || response.status === 403) {
    throw new SupplierAuthError(`Part-Kom API returned HTTP ${response.status}`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Part-Kom API returned HTTP ${response.status}`);
  }
  const payload = JSON.parse(response.body) as T & { success?: boolean; msg?: string; message?: string };
  if (payload.success === false && /unauthorized/i.test(payload.msg || payload.message || "")) {
    throw new SupplierAuthError(payload.msg || payload.message || "Part-Kom session is not authorized");
  }
  return payload;
}

export class PartKomApiAdapter implements SupplierAdapter {
  readonly id = "part-kom";
  readonly displayName = "Part-Kom";
  readonly timeoutMs = Number(process.env.PARTKOM_SEARCH_TIMEOUT_MS ?? "15000");

  async ensureSession(sessionManager: SupplierSessionManager): Promise<SupplierSessionState> {
    return hasPartKomStorageState() && getPartKomCookieHeader()
      ? sessionManager.markChecked(this.id, "Part-Kom stored API session is available")
      : sessionManager.markUnauthorized(this.id, "Part-Kom login is required");
  }

  async search(
    query: SearchQuery,
    context: SupplierSearchContext,
    onResult: (result: NormalizedSearchResult) => void,
    _sessionManager: SupplierSessionManager,
  ): Promise<void> {
    const article = query.article.trim();
    const baseParams = { number: article, excSubstitutes: "0", excAnalogues: "0", txtAddPrice: "0" };
    const autocomplete = await requestJson<PartKomAutocompleteResponse>(
      "/autocomplete_api_v2/",
      new URLSearchParams({ q: article }),
      context.signal,
    );
    const rows = [
      ...(autocomplete.data?.articul || []),
      ...(autocomplete.data?.parts || []),
      ...(autocomplete.data?.goods || []),
      ...(autocomplete.data?.autocomplete || []),
    ];
    const makerId = findPrimaryPartKomMakerId(rows, article);
    if (!makerId) {
      return;
    }
    const target = normalizeArticle(article);
    const search = await requestJson<PartKomSearchResponse>(
      "/search/",
      new URLSearchParams({ ...baseParams, maker_id: makerId, stores: "2" }),
      context.signal,
    );
    for (const part of search.exact || []) {
      if (normalizeArticle(part.number || "") !== target) continue;
      for (const offer of part.offers || []) {
        if (offer.number && normalizeArticle(offer.number) !== target) continue;
        const price = parsePrice(offer.price);
        if (price === null || Number(offer.quantity) === 0) continue;
        const offerArticle = offer.number || part.number || article;
        const offerMakerId = offer.maker_id ?? part.maker_id;
        onResult({
          supplier: this.id,
          brand: makerName(search.makers, offerMakerId, rows.find((row) => String(row.maker_id) === String(offerMakerId))?.maker || "Part-Kom"),
          article: offerArticle,
          title: offer.description || offer.name || part.description || part.name || offerArticle,
          price,
          warehouse: warehouse(offer, search.providers || []),
          deliveryDate: deliveryDate(offer.delivery_wave_date_from, offer.days_guaranteed),
          deliveryDateApproximate: true,
          link: new URL(`/new/#/search/0/0/0/${encodeURIComponent(article.replace(/\//g, ""))}/${encodeURIComponent(String(offerMakerId || ""))}`, partKomApiBaseUrl).toString(),
        });
      }
    }
  }
}
