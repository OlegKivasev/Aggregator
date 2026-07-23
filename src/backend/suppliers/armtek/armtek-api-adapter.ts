import { getArmtekApiConfig, type ArmtekApiConfig } from "../../config.ts";
import type { SupplierSessionManager } from "../../session/session-manager.ts";
import type {
  ArmtekCredentials,
  NormalizedSearchResult,
  SearchQuery,
  SupplierSearchContext,
  SupplierSessionState,
} from "../../types.ts";
import { SupplierAuthError } from "../errors.ts";
import type { SupplierAdapter } from "../supplier-adapter.ts";
import { getArmtekApiAccountState, saveArmtekApiAccountState } from "./armtek-api-account-state.ts";

interface ArmtekResponse<T> {
  STATUS?: number;
  MESSAGES?: Array<{ TYPE?: string; TEXT?: string }>;
  RESP?: T;
}

interface ArmtekVkorgItem {
  VKORG?: string;
}

interface ArmtekUserStructure {
  RG_TAB?: ArmtekCustomerItem[];
}

interface ArmtekCustomerItem {
  KUNNR?: string;
  DEFAULT?: string;
}

interface ArmtekSearchItem {
  PIN?: string;
  BRAND?: string;
  NAME?: string;
  PRICE?: string;
  DLVDT?: string;
  WRNTDT?: string;
  ANALOG?: string;
  STOCK?: string;
  STOCK_NAME?: string;
  WH?: string;
  WHNAME?: string;
  SNAME?: string;
  RNAME?: string;
  STORE?: string;
  STORE_NAME?: string;
  KEYZAK?: string;
  WAREHOUSE?: string;
  WAREHOUSE_NAME?: string;
}

interface ArmtekStoreItem {
  KEYZAK?: string;
  SKLCODE?: string;
  SKLNAME?: string;
}

interface ArmtekResolvedConfig {
  vkorg: string;
  kunnrRg: string;
  kunnrZa?: string;
  incoterms?: string;
  vbeln?: string;
  program?: string;
  queryType: string;
}

const armtekApiBaseUrl = process.env.ARMTEK_API_BASE_URL?.trim() || "https://ws.armtek.ru/api";
const armtekStoreNamesByVkorg = new Map<string, Promise<Map<string, string>>>();
function normalizeArticle(value: string): string {
  return value.replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

function parsePrice(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value.replace(/\s+/g, "").replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseArmtekDate(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const compactMatch = value.match(/^(\d{4})(\d{2})(\d{2})/);

  if (compactMatch) {
    const year = Number(compactMatch[1]);
    const monthIndex = Number(compactMatch[2]) - 1;
    const day = Number(compactMatch[3]);
    const date = new Date(year, monthIndex, day);

    return Number.isNaN(date.getTime()) ||
      date.getFullYear() !== year ||
      date.getMonth() !== monthIndex ||
      date.getDate() !== day
      ? null
      : date.toISOString();
  }

  return parseDeliveryText(value);
}

export function parseArmtekDeliveryDates(deliveryDate: string | undefined, warrantyDate: string | undefined): {
  deliveryDate: string | null;
  deliveryDateTo: string | null;
} {
  const dates = [parseArmtekDate(deliveryDate), parseArmtekDate(warrantyDate)]
    .filter((date): date is string => date !== null)
    .sort();

  return {
    deliveryDate: dates[0] ?? null,
    deliveryDateTo: dates[1] ?? null,
  };
}

function normalizeConcatenatedDottedDates(value: string): string {
  return value.replace(/(\d{1,2}\.\d{1,2}\.\d{2})(?=\d{1,2}\.\d{1,2}\.\d{2})/g, "$1 ");
}

function parseDeliveryText(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalized = normalizeConcatenatedDottedDates(value);
  const dayMatch = normalized.match(/(?:^|\D)(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})(?:\D|$)/);

  if (!dayMatch) {
    return null;
  }

  const day = Number(dayMatch[1]);
  const monthIndex = Number(dayMatch[2]) - 1;
  const year = Number(dayMatch[3].length === 2 ? `20${dayMatch[3]}` : dayMatch[3]);
  const date = new Date(year, monthIndex, day);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function getArmtekMessage(response: ArmtekResponse<unknown>): string {
  return (
    response.MESSAGES?.map((message) => message.TEXT?.trim()).filter(Boolean).join("; ") ||
    `Armtek returned status ${response.STATUS ?? "unknown"}`
  );
}

function getConfiguredCredentials(sessionManager: SupplierSessionManager): ArmtekCredentials | null {
  const runtimeCredentials = sessionManager.getArmtekCredentials();

  if (runtimeCredentials) {
    return runtimeCredentials;
  }

  const envConfig = getArmtekApiConfig();
  return envConfig ? { login: envConfig.login, password: envConfig.password } : null;
}

function defaultedConfig(credentials: ArmtekCredentials): ArmtekApiConfig {
  const envConfig = getArmtekApiConfig();
  const savedConfig = getArmtekApiAccountState(credentials.login);
  const configuredAccount = envConfig?.login === credentials.login ? envConfig : null;

  return {
    login: credentials.login,
    password: credentials.password,
    vkorg: configuredAccount?.vkorg || savedConfig?.vkorg,
    kunnrRg: configuredAccount?.kunnrRg || savedConfig?.kunnrRg,
    kunnrZa: configuredAccount?.kunnrZa,
    incoterms: configuredAccount?.incoterms,
    vbeln: configuredAccount?.vbeln,
    program: configuredAccount?.program,
    queryType: configuredAccount?.queryType || "1",
  };
}

function appendOptional(params: URLSearchParams, name: string, value: string | undefined) {
  if (value) {
    params.set(name, value);
  }
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

export function armtekVkorgItems(response: { ARRAY?: ArmtekVkorgItem | ArmtekVkorgItem[] } | ArmtekVkorgItem[]): ArmtekVkorgItem[] {
  return Array.isArray(response) ? response : toArray(response.ARRAY);
}

export function armtekSearchItems(response: { ARRAY?: ArmtekSearchItem | ArmtekSearchItem[] } | ArmtekSearchItem[]): ArmtekSearchItem[] {
  return Array.isArray(response) ? response : toArray(response.ARRAY);
}

function armtekStoreItems(response: { ARRAY?: ArmtekStoreItem | ArmtekStoreItem[] } | ArmtekStoreItem[]): ArmtekStoreItem[] {
  return Array.isArray(response) ? response : toArray(response.ARRAY);
}

async function requestArmtek<T>(
  path: string,
  credentials: ArmtekCredentials,
  options: {
    method: "GET" | "POST";
    params?: URLSearchParams;
    signal?: AbortSignal;
  },
): Promise<T> {
  const url = new URL(`${armtekApiBaseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`);
  url.searchParams.set("format", "json");

  if (options.method === "GET" && options.params) {
    for (const [name, value] of options.params) {
      url.searchParams.set(name, value);
    }
  }

  const response = await fetch(url, {
    method: options.method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${credentials.login}:${credentials.password}`).toString("base64")}`,
      ...(options.method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: options.method === "POST" ? options.params : undefined,
    signal: options.signal,
  });

  if (response.status === 401 || response.status === 403) {
    throw new SupplierAuthError("Armtek rejected login or password");
  }

  const payload = (await response.json()) as ArmtekResponse<T>;

  if (!response.ok || (payload.STATUS && payload.STATUS >= 400)) {
    throw new Error(getArmtekMessage(payload));
  }

  return payload.RESP as T;
}

async function resolveArmtekConfig(
  credentials: ArmtekCredentials,
  signal?: AbortSignal,
): Promise<ArmtekResolvedConfig> {
  const config = defaultedConfig(credentials);
  let vkorg = config.vkorg;

  if (!vkorg) {
    const vkorgResponse = await requestArmtek<{ ARRAY?: ArmtekVkorgItem | ArmtekVkorgItem[] } | ArmtekVkorgItem[]>("ws_user/getUserVkorgList", credentials, {
      method: "GET",
      signal,
    });
    vkorg = armtekVkorgItems(vkorgResponse).find((item) => item.VKORG)?.VKORG;
  }

  if (!vkorg) {
    throw new Error("Armtek did not return available VKORG values");
  }

  let kunnrRg = config.kunnrRg;

  if (!kunnrRg) {
    const params = new URLSearchParams({ VKORG: vkorg, STRUCTURE: "1" });
    const userInfo = await requestArmtek<{ STRUCTURE?: ArmtekUserStructure | ArmtekUserStructure[] }>("ws_user/getUserInfo", credentials, {
      method: "POST",
      params,
      signal,
    });
    const customers = toArray(userInfo.STRUCTURE).flatMap((structure) => toArray(structure.RG_TAB));
    kunnrRg = customers.find((customer) => customer.DEFAULT === "1" && customer.KUNNR)?.KUNNR;
    kunnrRg ||= customers.find((customer) => customer.KUNNR)?.KUNNR;
  }

  if (!kunnrRg) {
    throw new Error("Armtek did not return available KUNNR_RG values");
  }

  const resolved = {
    vkorg,
    kunnrRg,
    kunnrZa: config.kunnrZa,
    incoterms: config.incoterms,
    vbeln: config.vbeln,
    program: config.program,
    queryType: config.queryType,
  };
  saveArmtekApiAccountState(credentials.login, resolved.vkorg, resolved.kunnrRg);
  return resolved;
}

async function getArmtekStoreNames(credentials: ArmtekCredentials, vkorg: string, signal: AbortSignal): Promise<Map<string, string>> {
  const storesResponse = await requestArmtek<{ ARRAY?: ArmtekStoreItem | ArmtekStoreItem[] } | ArmtekStoreItem[]>("ws_user/getStoreList", credentials, {
    method: "POST",
    params: new URLSearchParams({ VKORG: vkorg }),
    signal,
  });
  return new Map(armtekStoreItems(storesResponse)
    .filter((store): store is Required<Pick<ArmtekStoreItem, "KEYZAK" | "SKLNAME">> => Boolean(store.KEYZAK && store.SKLNAME))
    .map((store) => [store.KEYZAK, store.SKLNAME]));
}

function getCachedArmtekStoreNames(credentials: ArmtekCredentials, vkorg: string, signal: AbortSignal): Promise<Map<string, string>> {
  const existing = armtekStoreNamesByVkorg.get(vkorg);
  if (existing) {
    return existing;
  }

  const request = getArmtekStoreNames(credentials, vkorg, signal).catch((error: unknown) => {
    armtekStoreNamesByVkorg.delete(vkorg);
    throw error;
  });
  armtekStoreNamesByVkorg.set(vkorg, request);
  return request;
}

function hasArmtekWarehouseName(item: ArmtekSearchItem): boolean {
  return Boolean(item.STOCK_NAME || item.WHNAME || item.WAREHOUSE_NAME || item.STORE_NAME || item.SNAME || item.RNAME);
}

function buildArmtekResultLink(article: string): string {
  const url = new URL("https://etp.armtek.ru/");
  url.searchParams.set("search", article);
  return url.toString();
}

export async function verifyArmtekCredentials(credentials: ArmtekCredentials): Promise<string> {
  await resolveArmtekConfig(credentials);
  return "Armtek account verified";
}

export class ArmtekApiAdapter implements SupplierAdapter {
  readonly id = "armtek";
  readonly displayName = "Armtek";
  readonly timeoutMs = 60000;

  async ensureSession(sessionManager: SupplierSessionManager): Promise<SupplierSessionState> {
    const credentials = getConfiguredCredentials(sessionManager);

    if (!credentials) {
      return sessionManager.markUnauthorized("armtek", "ARMTEK_LOGIN/ARMTEK_PASSWORD or Armtek credentials are not configured");
    }

    return sessionManager.markAuthorized("armtek", "Armtek API credentials are available");
  }

  async search(
    query: SearchQuery,
    searchContext: SupplierSearchContext,
    onResult: (result: NormalizedSearchResult) => void,
    sessionManager: SupplierSessionManager,
  ): Promise<void> {
    const credentials = getConfiguredCredentials(sessionManager);

    if (!credentials) {
      throw new SupplierAuthError("Armtek credentials are missing");
    }

    const resolved = await resolveArmtekConfig(credentials, searchContext.signal);
    const article = query.article.trim();
    const params = new URLSearchParams({
      VKORG: resolved.vkorg,
      KUNNR_RG: resolved.kunnrRg,
      PIN: article,
      QUERY_TYPE: resolved.queryType,
    });

    appendOptional(params, "KUNNR_ZA", resolved.kunnrZa);
    appendOptional(params, "INCOTERMS", resolved.incoterms);
    appendOptional(params, "VBELN", resolved.vbeln);
    appendOptional(params, "PROGRAM", resolved.program);

    const searchResponse = await requestArmtek<{ ARRAY?: ArmtekSearchItem | ArmtekSearchItem[] } | ArmtekSearchItem[]>("ws_search/search", credentials, {
      method: "POST",
      params,
      signal: searchContext.signal,
    });
    const normalizedTarget = normalizeArticle(article);
    const items = armtekSearchItems(searchResponse);
    const requiresStoreNames = items.some((item) =>
      normalizeArticle(item.PIN ?? "") === normalizedTarget && Boolean(item.KEYZAK) && !hasArmtekWarehouseName(item),
    );
    const storeNames = requiresStoreNames
      ? await getCachedArmtekStoreNames(credentials, resolved.vkorg, searchContext.signal)
      : new Map<string, string>();
    for (const item of items) {
      if (normalizeArticle(item.PIN ?? "") !== normalizedTarget) {
        continue;
      }

      const price = parsePrice(item.PRICE);
      const brand = item.BRAND?.trim();
      const itemArticle = item.PIN?.trim();
      const title = item.NAME?.trim();

      if (price === null || !brand || !itemArticle || !title) {
        continue;
      }

      onResult({
        supplier: this.id,
        brand,
        article: itemArticle,
        title,
        price,
        ...parseArmtekDeliveryDates(item.DLVDT, item.WRNTDT),
        warehouse: item.STOCK_NAME || item.WHNAME || item.WAREHOUSE_NAME || item.STORE_NAME || item.SNAME || item.RNAME || (item.KEYZAK ? storeNames.get(item.KEYZAK) : undefined) || item.STOCK || item.WH || item.WAREHOUSE || item.STORE || null,
        deliveryDateApproximate: false,
        link: buildArmtekResultLink(article),
      });
    }
  }
}
