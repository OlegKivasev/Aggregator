import type { SupplierSessionManager } from "../../session/session-manager.ts";
import type {
  NormalizedSearchResult,
  PartKomCredentials,
  SearchQuery,
  SupplierSearchContext,
  SupplierSessionState,
} from "../../types.ts";
import { SupplierAuthError, SupplierIntegrationError } from "../errors.ts";
import { siteHttpRequest } from "../site-http.ts";
import type { SupplierAdapter } from "../supplier-adapter.ts";

interface PartKomOffer {
  number?: unknown;
  maker?: unknown;
  makerId?: unknown;
  description?: unknown;
  price?: unknown;
  quantity?: unknown;
  placement?: unknown;
  expectedDate?: unknown;
  guaranteedDate?: unknown;
  expectedHours?: unknown;
  guaranteedHours?: unknown;
  expectedDays?: unknown;
  guaranteedDays?: unknown;
}

export type PartKomApiRequester = (
  path: "search/brands" | "search/offers",
  params: URLSearchParams,
  signal: AbortSignal,
  timeoutMs: number,
  credentials: PartKomCredentials,
) => Promise<unknown>;

const partKomApiBaseUrl = new URL("https://ws.part-kom.ru/v4/");
const partKomSiteBaseUrl = new URL("https://www.part-kom.ru/");
const partKomMaxResponseBytes = 5 * 1024 * 1024;

function readPartKomSearchTimeoutMs(): number {
  const timeoutMs = Number(process.env.PARTKOM_SEARCH_TIMEOUT_MS ?? "15000");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new Error("PARTKOM_SEARCH_TIMEOUT_MS must be between 1 and 120000");
  }
  return timeoutMs;
}

function normalizeArticle(value: string): string {
  return value.replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

function parsePositiveNumber(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value.replace(/\s+/g, "").replace(",", ".")) : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseApiDate(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?$/);
  if (!match) {
    return null;
  }
  const [, year, month, day, hours = "00", minutes = "00", seconds = "00"] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hours), Number(minutes), Number(seconds));
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== Number(year) ||
    date.getMonth() !== Number(month) - 1 ||
    date.getDate() !== Number(day) ||
    date.getHours() !== Number(hours) ||
    date.getMinutes() !== Number(minutes) ||
    date.getSeconds() !== Number(seconds)
  ) {
    return null;
  }
  return date.toISOString();
}

function dateFromDuration(hours: unknown, days: unknown): string | null {
  const parsedHours = typeof hours === "number" || typeof hours === "string" && hours.trim() ? Number(hours) : Number.NaN;
  const parsedDays = typeof days === "number" || typeof days === "string" && days.trim() ? Number(days) : Number.NaN;
  const durationHours = Number.isFinite(parsedHours) && parsedHours >= 0
    ? parsedHours
    : Number.isFinite(parsedDays) && parsedDays >= 0 ? parsedDays * 24 : null;
  return durationHours === null ? null : new Date(Date.now() + durationHours * 60 * 60 * 1000).toISOString();
}

function apiItems(payload: unknown, responseName: string): unknown[] {
  if (!Array.isArray(payload)) {
    throw new SupplierIntegrationError(`PartKOM API returned an invalid ${responseName} response`);
  }
  return payload;
}

export function parsePartKomApiResults(payload: unknown, requestedArticle: string): NormalizedSearchResult[] {
  const target = normalizeArticle(requestedArticle);
  const results: NormalizedSearchResult[] = [];

  for (const value of apiItems(payload, "offers")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const offer = value as PartKomOffer;
    const article = typeof offer.number === "string" ? offer.number.trim() : "";
    const brand = typeof offer.maker === "string" ? offer.maker.trim() : "";
    const title = typeof offer.description === "string" ? offer.description.trim() : "";
    const price = parsePositiveNumber(offer.price);
    const quantity = Number(offer.quantity);
    if (!article || normalizeArticle(article) !== target || !brand || !title || price === null || !Number.isFinite(quantity) || quantity <= 0) {
      continue;
    }
    const expectedDate = parseApiDate(offer.expectedDate) ?? dateFromDuration(offer.expectedHours, offer.expectedDays);
    const guaranteedDate = parseApiDate(offer.guaranteedDate) ?? dateFromDuration(offer.guaranteedHours, offer.guaranteedDays);
    const deliveryDateTo = expectedDate && guaranteedDate && Date.parse(guaranteedDate) > Date.parse(expectedDate)
      ? guaranteedDate
      : null;
    const makerId = typeof offer.makerId === "string" || typeof offer.makerId === "number" ? String(offer.makerId) : "";
    results.push({
      supplier: "part-kom",
      brand,
      article,
      title,
      price,
      warehouse: typeof offer.placement === "string" && offer.placement.trim() ? offer.placement.trim() : null,
      deliveryDate: expectedDate,
      deliveryDateTo,
      deliveryDateApproximate: !parseApiDate(offer.expectedDate),
      link: new URL(`/new/#/search/0/0/0/${encodeURIComponent(article.replace(/\//g, ""))}/${encodeURIComponent(makerId)}`, partKomSiteBaseUrl).toString(),
    });
  }
  return results;
}

async function partKomApiRequest(
  path: "search/brands" | "search/offers",
  params: URLSearchParams,
  signal: AbortSignal,
  timeoutMs: number,
  credentials: PartKomCredentials,
): Promise<unknown> {
  const url = new URL(path, partKomApiBaseUrl);
  url.search = params.toString();
  const authorization = Buffer.from(`${credentials.login}:${credentials.password}`, "utf8").toString("base64");
  const response = await siteHttpRequest(url, {
    headers: { Accept: "application/json", Authorization: `Basic ${authorization}` },
    signal,
    timeoutMs,
    maxResponseBytes: partKomMaxResponseBytes,
  });
  if (response.status === 401 || response.status === 403) {
    throw new SupplierAuthError("PartKOM API rejected the configured credentials");
  }
  if (response.status < 200 || response.status >= 300) {
    throw new SupplierIntegrationError(`PartKOM API returned HTTP ${response.status}`);
  }
  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    throw new SupplierIntegrationError("PartKOM API returned invalid JSON");
  }
}

export async function verifyPartKomApiCredentials(
  credentials: PartKomCredentials,
  request: PartKomApiRequester = partKomApiRequest,
): Promise<void> {
  const payload = await request("search/brands", new URLSearchParams(), AbortSignal.timeout(10_000), 10_000, credentials);
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      const details = /wrong ip address/i.test(message)
        ? "PartKOM API rejected the server IP address"
        : "PartKOM API rejected the connection check";
      throw new SupplierIntegrationError(details);
    }
  }
}

export class PartKomApiAdapter implements SupplierAdapter {
  readonly id = "part-kom";
  readonly displayName = "PartKOM";
  readonly timeoutMs = readPartKomSearchTimeoutMs();
  private readonly request: PartKomApiRequester;

  constructor(request: PartKomApiRequester = partKomApiRequest) {
    this.request = request;
  }

  async ensureSession(sessionManager: SupplierSessionManager): Promise<SupplierSessionState> {
    return sessionManager.getPartKomCredentials()
      ? sessionManager.markChecked(this.id, "PartKOM API credentials are configured")
      : sessionManager.markUnauthorized(this.id, "PartKOM API credentials are not configured");
  }

  async validateSession(context: SupplierSearchContext, sessionManager: SupplierSessionManager): Promise<void> {
    const credentials = sessionManager.getPartKomCredentials();
    if (!credentials) {
      throw new SupplierAuthError("PartKOM API credentials are not configured");
    }
    await this.request("search/brands", new URLSearchParams(), context.signal, context.timeoutMs, credentials);
  }

  async search(
    query: SearchQuery,
    context: SupplierSearchContext,
    onResult: (result: NormalizedSearchResult) => void,
    sessionManager: SupplierSessionManager,
  ): Promise<void> {
    const credentials = sessionManager.getPartKomCredentials();
    if (!credentials) {
      throw new SupplierAuthError("PartKOM API credentials are not configured");
    }
    const article = query.article.trim();
    const payload = await this.request(
      "search/offers",
      new URLSearchParams({ number: article, find_substitutes: "0" }),
      context.signal,
      context.timeoutMs,
      credentials,
    );
    parsePartKomApiResults(payload, article).forEach(onResult);
  }
}
