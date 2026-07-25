import { partKomSearchTimeoutMs } from "../../config.ts";
import type { SupplierSessionManager } from "../../session/session-manager.ts";
import type {
  NormalizedSearchResult,
  PartKomCredentials,
  SearchQuery,
  SupplierSearchContext,
  SupplierSessionState,
} from "../../types.ts";
import { SupplierAuthError, SupplierIntegrationError } from "../errors.ts";
import { siteHttpRequest, type SiteHttpResponse } from "../site-http.ts";
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

function partKomErrorText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const problem = payload as Record<string, unknown>;
  for (const field of ["message", "detail", "error", "title"]) {
    if (typeof problem[field] === "string" && problem[field].trim()) {
      return problem[field].trim();
    }
  }
  return null;
}

function isPartKomIpRestriction(payload: unknown): boolean {
  const message = partKomErrorText(payload);
  return Boolean(message && /wrong\s+ip|ip(?:\s+address|-адрес)/i.test(message));
}

function partKomIpRestrictionError(): SupplierIntegrationError {
  return new SupplierIntegrationError("PartKOM API rejected the server IP address", {
    publicMessage: "PartKOM API access is not allowed from this server IP address",
  });
}

function partKomPayloadShape(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return `partkom_brands_${payload === null ? "null" : Array.isArray(payload) ? "array" : typeof payload}`;
  }
  const fields = Object.entries(payload).slice(0, 8).map(([name, value]) => {
    const safeName = name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 24) || "field";
    const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    return `${safeName}-${type}`;
  });
  return `partkom_brands_object_${fields.length ? fields.join("_") : "empty"}`;
}

export function parsePartKomApiResponse(response: SiteHttpResponse): unknown {
  let payload: unknown;
  try {
    payload = JSON.parse(response.body.replace(/^\uFEFF/, "")) as unknown;
  } catch {
    payload = undefined;
  }
  if (isPartKomIpRestriction(payload)) {
    throw partKomIpRestrictionError();
  }
  if (response.status === 401 || response.status === 403) {
    throw new SupplierAuthError("PartKOM API rejected the configured credentials");
  }
  if (response.status < 200 || response.status >= 300) {
    throw new SupplierIntegrationError(`PartKOM API returned HTTP ${response.status}`, {
      publicMessage: "PartKOM API is temporarily unavailable",
    });
  }
  if (payload === undefined) {
    throw new SupplierIntegrationError("PartKOM API returned invalid JSON", {
      publicMessage: "PartKOM API returned invalid JSON",
    });
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const envelope = payload as { success?: unknown; data?: unknown };
    if (envelope.success === true) {
      if (Array.isArray(envelope.data)) {
        return envelope.data;
      }
      throw new SupplierIntegrationError("PartKOM API returned an invalid success envelope", {
        publicMessage: "PartKOM API returned an unsupported response",
        diagnosticCode: partKomPayloadShape(payload),
      });
    }
    if (envelope.success === false) {
      throw new SupplierIntegrationError("PartKOM API rejected the request", {
        publicMessage: "PartKOM API rejected the request",
        diagnosticCode: partKomPayloadShape(payload),
      });
    }
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
  return parsePartKomApiResponse(response);
}

export async function verifyPartKomApiCredentials(
  credentials: PartKomCredentials,
  request: PartKomApiRequester = partKomApiRequest,
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<void> {
  const payload = await request("search/brands", new URLSearchParams(), signal, 10_000, credentials);
  validatePartKomConnectionPayload(payload);
}

function validatePartKomConnectionPayload(payload: unknown): void {
  if (Array.isArray(payload)) {
    return;
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    if (isPartKomIpRestriction(payload)) {
      throw partKomIpRestrictionError();
    }
    if (partKomErrorText(payload)) {
      throw new SupplierIntegrationError("PartKOM API rejected the connection check", {
        publicMessage: "PartKOM API rejected the connection check",
      });
    }
    if (Array.isArray((payload as { brands?: unknown }).brands)) {
      return;
    }
  }
  throw new SupplierIntegrationError("PartKOM API returned an invalid brands response", {
    publicMessage: "PartKOM API returned an unsupported brands response",
    diagnosticCode: partKomPayloadShape(payload),
  });
}

export class PartKomApiAdapter implements SupplierAdapter {
  readonly id = "part-kom";
  readonly displayName = "PartKOM";
  readonly timeoutMs = partKomSearchTimeoutMs;
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
    const payload = await this.request("search/brands", new URLSearchParams(), context.signal, context.timeoutMs, credentials);
    validatePartKomConnectionPayload(payload);
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
