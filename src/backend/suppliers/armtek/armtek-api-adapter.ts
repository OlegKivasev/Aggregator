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
import { siteHttpRequest } from "../site-http.ts";
import type { SupplierAdapter } from "../supplier-adapter.ts";
import {
  armtekEtpUrl,
  createArmtekContext,
  getArmtekCookieHeader,
  getArmtekSharedBrowser,
  hasArmtekStorageState,
  performArmtekLogin,
} from "./armtek-site-auth.ts";

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
  WAREHOUSE?: string;
  WAREHOUSE_NAME?: string;
}

interface ArmtekEtpParam {
  ARTID?: string;
  RSTP?: string;
  PIN?: string;
  BRAND?: string;
  NAME?: string;
  PRICES1?: string;
  DLVDT?: string;
  WRNTDT?: string;
  SNAME?: string;
}

interface ArmtekEtpSearchResponse {
  status?: boolean;
  arr_messages?: Array<{ text?: string }>;
  data?: {
    TBL?: {
      SRCDATA?: ArmtekEtpGroup[];
      FIRSTDATA?: ArmtekEtpGroup[];
    };
  };
}

interface ArmtekEtpGroup {
  ARTID?: string;
  RSTP?: string;
  NAMES?: Array<{ PARAMS?: ArmtekEtpParam[] }>;
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
const armtekEtpBaseUrl = process.env.ARMTEK_ETP_BASE_URL?.trim() || "https://etp.armtek.ru/";
const armtekEtpAmbiguousLimit = Math.max(1, Number(process.env.ARMTEK_ETP_AMBIGUOUS_LIMIT ?? "20"));
const armtekEtpRequestDelayMs = Math.max(1000, Number(process.env.ARMTEK_ETP_REQUEST_DELAY_MS ?? "1100"));
const armtekEtpWorkers = Math.min(3, Math.max(1, Math.floor(Number(process.env.ARMTEK_ETP_WORKERS ?? "3")) || 3));

let cachedArmtekEtpCookie: { storedCookie: string; activeCookie: string } | null = null;

function normalizeArticle(value: string): string {
  return value.replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

function parsePrice(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value.replace(/\s+/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
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

    return Number.isNaN(date.getTime()) ? null : date.toISOString();
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

  return {
    login: credentials.login,
    password: credentials.password,
    vkorg: envConfig?.vkorg,
    kunnrRg: envConfig?.kunnrRg,
    kunnrZa: envConfig?.kunnrZa,
    incoterms: envConfig?.incoterms,
    vbeln: envConfig?.vbeln,
    program: envConfig?.program,
    queryType: envConfig?.queryType || "1",
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
    const vkorgResponse = await requestArmtek<{ ARRAY?: ArmtekVkorgItem | ArmtekVkorgItem[] }>("ws_user/getUserVkorgList", credentials, {
      method: "GET",
      signal,
    });
    vkorg = toArray(vkorgResponse.ARRAY).find((item) => item.VKORG)?.VKORG;
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

  return {
    vkorg,
    kunnrRg,
    kunnrZa: config.kunnrZa,
    incoterms: config.incoterms,
    vbeln: config.vbeln,
    program: config.program,
    queryType: config.queryType,
  };
}

function buildArmtekResultLink(article: string): string {
  const url = new URL(armtekEtpBaseUrl);
  url.searchParams.set("search", article);
  return url.toString();
}

function mergeCookieHeader(cookie: string, setCookies: string[]): string {
  const values = new Map(cookie.split(/;\s*/).map((item) => {
    const separator = item.indexOf("=");
    return [item.slice(0, separator), item.slice(separator + 1)];
  }));
  for (const setCookie of setCookies) {
    const pair = setCookie.split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator > 0) values.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  return [...values].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function getActiveArmtekEtpCookie(signal: AbortSignal): Promise<string> {
  const storedCookie = getArmtekCookieHeader();
  if (!storedCookie) {
    throw new SupplierAuthError("Armtek ETP stored session is not available");
  }
  if (cachedArmtekEtpCookie?.storedCookie === storedCookie) {
    return cachedArmtekEtpCookie.activeCookie;
  }
  const response = await siteHttpRequest(new URL("/search/", armtekEtpUrl), { cookie: storedCookie, signal, timeoutMs: 3500 });
  if (response.status === 401 || response.status === 403 || response.body.trim().length < 1000 || /id=["']login["']/i.test(response.body)) {
    throw new SupplierAuthError("Armtek ETP stored session is expired");
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Armtek ETP session initialization returned HTTP ${response.status}`);
  }
  const activeCookie = mergeCookieHeader(storedCookie, response.setCookie);
  cachedArmtekEtpCookie = { storedCookie, activeCookie };
  return activeCookie;
}

async function requestArmtekEtpSearch(
  cookie: string,
  article: string,
  query: string,
  queryType: string,
  queryData: string,
  signal: AbortSignal,
): Promise<ArmtekEtpSearchResponse> {
  const body = new URLSearchParams({
    QUERY: query,
    QUERY_TYPE: queryType,
    QUERY_DATA: queryData,
    QUERY_HYSTORY: article,
    OPTRS: "true",
    PKW: "",
    LKW: "",
    VIEW: "short",
    GROUP: "0",
    ZZSING: "S",
    cashKey: "",
    page: "1",
    TTLLN: "0",
    SRCNT: "0",
    FORMAT: "json",
    LANG: "ru",
  }).toString();
  const searchUrl = new URL("/search/getArticlesBySearch/", armtekEtpUrl);
  searchUrl.search = String(Math.random());
  const response = await siteHttpRequest(searchUrl, {
    cookie,
    signal,
    timeoutMs: 3500,
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "Content-Length": String(Buffer.byteLength(body)),
      "X-Requested-With": "XMLHttpRequest",
      Referer: new URL("/search/", armtekEtpUrl).toString(),
    },
  });
  if (response.status === 401 || response.status === 403) {
    throw new SupplierAuthError(`Armtek ETP returned HTTP ${response.status}`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Armtek ETP returned HTTP ${response.status}`);
  }
  const payload = JSON.parse(response.body) as ArmtekEtpSearchResponse;
  if (!payload.status) {
    const message = payload.arr_messages?.map((item) => item.text).filter(Boolean).join("; ") || "Armtek ETP search failed";
    if (/авториз|сесси|login/i.test(message)) throw new SupplierAuthError(message);
    throw new Error(message);
  }
  return payload;
}

function exactEtpItems(payload: ArmtekEtpSearchResponse, target: string): ArmtekEtpParam[] {
  return (payload.data?.TBL?.SRCDATA || [])
    .filter((group) => group.RSTP === "0")
    .flatMap((group) => group.NAMES || [])
    .flatMap((name) => name.PARAMS || [])
    .filter((item) => normalizeArticle(item.PIN || "") === target);
}

export function armtekEtpCandidateIds(payload: ArmtekEtpSearchResponse, limit = armtekEtpAmbiguousLimit): string[] {
  return (payload.data?.TBL?.FIRSTDATA || [])
    .map((group) => group.ARTID)
    .filter((artid): artid is string => Boolean(artid))
    .slice(0, limit);
}

function waitForArmtekEtp(signal: AbortSignal, delayMs = armtekEtpRequestDelayMs): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function searchArmtekEtpCandidates(
  candidateIds: string[],
  request: (artid: string) => Promise<ArmtekEtpParam[]>,
  signal: AbortSignal,
  onItems: (items: ArmtekEtpParam[]) => void,
  previousRequestStartedAt: number,
): Promise<void> {
  let lastRequestStartedAt = previousRequestStartedAt;
  for (const artid of candidateIds) {
    const delayMs = Math.max(0, armtekEtpRequestDelayMs - (Date.now() - lastRequestStartedAt));
    if (delayMs > 0) {
      await waitForArmtekEtp(signal, delayMs);
    }
    lastRequestStartedAt = Date.now();
    onItems(await request(artid));
  }
}

function emitArmtekEtpItems(
  items: ArmtekEtpParam[],
  article: string,
  onResult: (result: NormalizedSearchResult) => void,
  seen = new Set<string>(),
): number {
  let emitted = 0;
  for (const item of items) {
    const price = parsePrice(item.PRICES1);
    if (price === null || price <= 0) continue;
    const key = `${item.ARTID || ""}|${item.BRAND || ""}|${price}|${item.SNAME || ""}|${item.WRNTDT || item.DLVDT || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    emitted += 1;
    onResult({
      supplier: "armtek",
      brand: item.BRAND || "Armtek",
      article: item.PIN || article,
      title: item.NAME || item.PIN || article,
      price,
      ...parseArmtekDeliveryDates(item.DLVDT, item.WRNTDT),
      warehouse: item.SNAME || null,
      deliveryDateApproximate: false,
      link: buildArmtekResultLink(article),
    });
  }
  return emitted;
}

async function searchArmtekEtpInBrowser(article: string, signal: AbortSignal): Promise<ArmtekEtpParam[]> {
  const browser = await getArmtekSharedBrowser();
  const context = await createArmtekContext(browser);
  const closeOnAbort = () => context.close().catch(() => undefined);
  signal.addEventListener("abort", closeOnAbort, { once: true });

  try {
    const page = await context.newPage();
    await page.goto(new URL("/search/", armtekEtpUrl).toString(), { waitUntil: "commit", timeout: 7000 });
    if (page.url().includes("redirect_url=")) {
      throw new SupplierAuthError("Armtek ETP stored session is expired");
    }
    return await page.evaluate(async ({ query, limit, delayMs }: { query: string; limit: number; delayMs: number }) => {
      const request = async (value: string, queryType: string, queryData: string) => {
        const body = new URLSearchParams({
          QUERY: value, QUERY_TYPE: queryType, QUERY_DATA: queryData, QUERY_HYSTORY: query,
          OPTRS: "true", PKW: "", LKW: "", VIEW: "short", GROUP: "0", ZZSING: "S",
          cashKey: "", page: "1", TTLLN: "0", SRCNT: "0", FORMAT: "json", LANG: "ru",
        });
        const response = await fetch(`/search/getArticlesBySearch/?${Math.random()}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" },
          body,
        });
        return await response.json();
      };
      const normalize = (value: string) => value.replace(/[^A-Z0-9]/gi, "").toUpperCase();
      const exact = (payload: any) => (payload.data?.TBL?.SRCDATA || [])
        .filter((group: any) => group.RSTP === "0")
        .flatMap((group: any) => group.NAMES || [])
        .flatMap((name: any) => name.PARAMS || [])
        .filter((item: any) => normalize(item.PIN || "") === normalize(query));
      const initial = await request(query, "1", "S1");
      const items = exact(initial);
      const candidates = (initial.data?.TBL?.FIRSTDATA || []).map((group: any) => group.ARTID).filter(Boolean).slice(0, limit);
      let lastRequestStartedAt = performance.now();
      for (const artid of candidates) {
        const remainingDelayMs = Math.max(0, delayMs - (performance.now() - lastRequestStartedAt));
        if (remainingDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, remainingDelayMs));
        lastRequestStartedAt = performance.now();
        items.push(...exact(await request(artid, "5", "S2")));
      }
      return items;
    }, { query: article, limit: armtekEtpAmbiguousLimit, delayMs: armtekEtpRequestDelayMs }) as ArmtekEtpParam[];
  } finally {
    signal.removeEventListener("abort", closeOnAbort);
    await context.close().catch(() => undefined);
  }
}

async function searchArmtekEtpWithWorkers(
  credentials: ArmtekCredentials,
  article: string,
  signal: AbortSignal,
  onResult: (result: NormalizedSearchResult) => void,
): Promise<void> {
  const browser = await getArmtekSharedBrowser();
  const contexts: any[] = [];
  const closeOnAbort = () => Promise.all(contexts.map((context) => context.close().catch(() => undefined)));
  signal.addEventListener("abort", closeOnAbort, { once: true });
  const seen = new Set<string>();

  try {
    await Promise.all(Array.from({ length: armtekEtpWorkers }, async (_, workerIndex) => {
      const context = await browser.newContext();
      contexts.push(context);
      const page = await context.newPage();
      const authorization = await performArmtekLogin(page, credentials);
      if (!authorization.authorized) {
        throw new SupplierAuthError(authorization.details);
      }

      const items = await page.evaluate(async ({ query, limit, workerIndex, workerCount }: {
        query: string;
        limit: number;
        workerIndex: number;
        workerCount: number;
      }) => {
        const request = async (value: string, queryType: string, queryData: string) => {
          const body = new URLSearchParams({
            QUERY: value, QUERY_TYPE: queryType, QUERY_DATA: queryData, QUERY_HYSTORY: query,
            OPTRS: "true", PKW: "", LKW: "", VIEW: "short", GROUP: "0", ZZSING: "S",
            cashKey: "", page: "1", TTLLN: "0", SRCNT: "0", FORMAT: "json", LANG: "ru",
          });
          const response = await fetch(`/search/getArticlesBySearch/?${Math.random()}`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" },
            body,
          });
          return await response.json();
        };
        const normalize = (value: string) => value.replace(/[^A-Z0-9]/gi, "").toUpperCase();
        const exact = (payload: any) => (payload.data?.TBL?.SRCDATA || [])
          .filter((group: any) => group.RSTP === "0")
          .flatMap((group: any) => group.NAMES || [])
          .flatMap((name: any) => name.PARAMS || [])
          .filter((item: any) => normalize(item.PIN || "") === normalize(query));
        const initial = await request(query, "1", "S1");
        const candidates = (initial.data?.TBL?.FIRSTDATA || [])
          .map((group: any) => group.ARTID)
          .filter(Boolean)
          .slice(0, limit)
          .filter((_: string, index: number) => index % workerCount === workerIndex);
        const items = exact(initial);

        for (const artid of candidates) {
          const startedAt = Date.now();
          while (true) {
            const payload = await request(artid, "5", "S2");
            if (payload.status === true) {
              items.push(...exact(payload));
              break;
            }
            if (Date.now() - startedAt >= 5000) {
              throw new Error("Armtek brand search timed out");
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        }
        return items;
      }, { query: article, limit: armtekEtpAmbiguousLimit, workerIndex, workerCount: armtekEtpWorkers }) as ArmtekEtpParam[];

      emitArmtekEtpItems(items, article, onResult, seen);
    }));
  } finally {
    signal.removeEventListener("abort", closeOnAbort);
    await Promise.all(contexts.map((context) => context.close().catch(() => undefined)));
  }
}

async function searchArmtekEtp(
  _credentials: ArmtekCredentials | null,
  query: SearchQuery,
  searchContext: SupplierSearchContext,
  onResult: (result: NormalizedSearchResult) => void,
): Promise<void> {
  const article = query.article.trim();
  const seen = new Set<string>();

  if (_credentials) {
    await searchArmtekEtpWithWorkers(_credentials, article, searchContext.signal, onResult);
    return;
  }

  try {
    const cookie = await getActiveArmtekEtpCookie(searchContext.signal);
    const target = normalizeArticle(article);
    const initialRequestStartedAt = Date.now();
    const initial = await requestArmtekEtpSearch(cookie, article, article, "1", "S1", searchContext.signal);
    emitArmtekEtpItems(exactEtpItems(initial, target), article, onResult, seen);
    await searchArmtekEtpCandidates(
      armtekEtpCandidateIds(initial),
      async (artid) => exactEtpItems(
        await requestArmtekEtpSearch(cookie, article, artid, "5", "S2", searchContext.signal),
        target,
      ),
      searchContext.signal,
      (items) => emitArmtekEtpItems(items, article, onResult, seen),
      initialRequestStartedAt,
    );
  } catch (error) {
    if (error instanceof SupplierAuthError || searchContext.signal.aborted) throw error;
    const items = await searchArmtekEtpInBrowser(article, searchContext.signal);
    emitArmtekEtpItems(items, article, onResult, seen);
  }
}

export async function verifyArmtekCredentials(credentials: ArmtekCredentials): Promise<string> {
  await resolveArmtekConfig(credentials);
  return "Armtek account verified";
}

export class ArmtekApiAdapter implements SupplierAdapter {
  readonly id = "armtek";
  readonly displayName = "Armtek";
  readonly timeoutMs = 30000;

  async ensureSession(sessionManager: SupplierSessionManager): Promise<SupplierSessionState> {
    const credentials = getConfiguredCredentials(sessionManager);

    if (!credentials) {
      if (hasArmtekStorageState()) {
        return sessionManager.markAuthorized("armtek", "Armtek ETP stored session is available");
      }

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
      if (hasArmtekStorageState()) {
        await searchArmtekEtp(null, query, searchContext, onResult);
        return;
      }

      throw new SupplierAuthError("Armtek credentials are missing");
    }

    let resolved: ArmtekResolvedConfig;

    try {
      resolved = await resolveArmtekConfig(credentials, searchContext.signal);
    } catch (error) {
      if (error instanceof SupplierAuthError && hasArmtekStorageState()) {
        await searchArmtekEtp(credentials, query, searchContext, onResult);
        return;
      }

      throw error;
    }
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

    let searchResponse: { ARRAY?: ArmtekSearchItem | ArmtekSearchItem[] };

    try {
      searchResponse = await requestArmtek<{ ARRAY?: ArmtekSearchItem | ArmtekSearchItem[] }>("ws_search/search", credentials, {
        method: "POST",
        params,
        signal: searchContext.signal,
      });
    } catch (error) {
      if (error instanceof SupplierAuthError && hasArmtekStorageState()) {
        await searchArmtekEtp(credentials, query, searchContext, onResult);
        return;
      }

      throw error;
    }
    const normalizedTarget = normalizeArticle(article);
    const items = toArray(searchResponse.ARRAY);
    let emitted = 0;

    for (const item of items) {
      if (normalizeArticle(item.PIN ?? "") !== normalizedTarget) {
        continue;
      }

      const price = parsePrice(item.PRICE);

      if (price === null) {
        continue;
      }

      emitted += 1;
      onResult({
        supplier: this.id,
        brand: item.BRAND || "Armtek",
        article: item.PIN || article,
        title: item.NAME || item.PIN || article,
        price,
        ...parseArmtekDeliveryDates(item.DLVDT, item.WRNTDT),
        warehouse: item.STOCK_NAME || item.WHNAME || item.WAREHOUSE_NAME || item.STOCK || item.WH || item.WAREHOUSE || null,
        deliveryDateApproximate: false,
        link: buildArmtekResultLink(article),
      });
    }

  }
}
