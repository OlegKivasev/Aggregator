import { mladovConfig, supplierMaxResponseBytes } from "../../config.ts";
import type { SupplierSessionManager } from "../../session/session-manager.ts";
import type { NormalizedSearchResult, SearchQuery, SupplierSearchContext, SupplierSessionState } from "../../types.ts";
import { SupplierAuthError, SupplierIntegrationError } from "../errors.ts";
import { siteHttpRequest } from "../site-http.ts";
import type { SupplierAdapter } from "../supplier-adapter.ts";
import {
  createMladovContext,
  getMladovStorageStateGeneration,
  getMladovSharedBrowser,
  hasMladovStorageState,
  isMladovAuthenticated,
  mladovBaseUrl,
  performMladovLogin,
  saveMladovStorageState,
} from "./mladov-site-auth.ts";

interface MladovResultItem {
  article: string;
  brand: string;
  title: string;
  price: number;
  warehouse: string | null;
  quantityText: string | null;
  deliveryText: string | null;
}

function normalizeArticle(value: string): string {
  return value.replace(/[^\p{L}\p{N}]/gu, "").toLocaleUpperCase("ru-RU");
}

function encodeWindows1251(value: string): string {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    let byte: number | null = null;

    if (code < 0x80) {
      byte = code;
    } else if (code >= 0x0410 && code <= 0x044f) {
      byte = code - 0x0410 + 0xc0;
    } else if (code === 0x0401) {
      byte = 0xa8;
    } else if (code === 0x0451) {
      byte = 0xb8;
    }

    if (byte === null) {
      return encodeURIComponent(character);
    }

    const isUnescaped =
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      [0x2d, 0x2e, 0x5f, 0x7e, 0x2a].includes(byte);
    return isUnescaped ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
}

export function parseMladovQuantity(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.replace(/\s+/g, "").replace(",", ".");
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed <= Number.MAX_SAFE_INTEGER ? parsed : null;
}

export function isMladovNoResultsPageText(value: string): boolean {
  return /ничего не найдено|не найдено соответствий|товар(?:ы)? не найден(?:о|ы)?|нет (?:предложений|товар(?:а|ов)|результатов)|товар отсутствует|по вашему запросу не найдено|(?:некорректн|недопустим)\S*.*артикул|артикул.*(?:некорректн|недопустим)/i.test(value);
}

function parseDeliveryDate(value: string | null): { date: string | null; approximate: boolean } {
  if (!value) {
    return { date: null, approximate: false };
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  const days = normalized.match(/(\d+)\s*(?:дн|день|дня|дней)/i);
  const offset = days ? Number(days[1]) : null;

  if (offset === null) {
    return { date: null, approximate: false };
  }

  const now = new Date();
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  return { date: date.toISOString(), approximate: true };
}

async function fetchMladovResults(
  context: any,
  page: any,
  article: string,
  signal: AbortSignal,
): Promise<MladovResultItem[]> {
  const cookies = await context.cookies(mladovBaseUrl) as Array<{ name?: string; value?: string }>;
  const cookie = cookies
    .filter((item) => item.name && item.value)
    .map((item) => `${item.name}=${item.value}`)
    .join("; ");
  const response = await siteHttpRequest(new URL("/ajaxshop3.php", mladovBaseUrl), {
    method: "POST",
    headers: {
      Accept: "text/html",
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: mladovBaseUrl,
    },
    cookie,
    body: new URLSearchParams({ artikul: article }).toString(),
    signal,
    timeoutMs: mladovConfig.requestTimeoutMs,
    maxResponseBytes: supplierMaxResponseBytes,
    returnRawBody: true,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new SupplierIntegrationError(`Поиск Механик Ладов вернул HTTP ${response.status}`);
  }
  if (!response.contentType?.toLowerCase().includes("text/html")) {
    throw new SupplierIntegrationError("Поиск Механик Ладов вернул неожиданный тип ответа");
  }
  if (!response.rawBody) {
    throw new SupplierIntegrationError("Поиск Механик Ладов вернул пустой ответ");
  }
  const html = new TextDecoder("windows-1251").decode(response.rawBody);
  await page.setContent(html);
  if ((await page.locator('input[name="username"], input[name="userpassword"]').count()) > 0) {
    throw new SupplierAuthError("Сессия Механик Ладов истекла");
  }
  const items = (await page.locator("div.trtable2").evaluateAll((rows: Element[]) =>
    rows.map((row) => {
      const text = (selector: string) => row.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() || "";
      const detailCells = Array.from(row.querySelectorAll(".col-md-1.hidden-sm.hidden-xs"));
      const detail = (index: number) => detailCells[index]?.textContent?.replace(/\s+/g, " ").trim() || null;
      const articleCell = row.querySelector(".col-md-2.col-xs-4");
      const article = Array.from(articleCell?.childNodes || [])
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent || "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      const priceMatch = text(".tableprice").match(/\d[\d\s]*(?:[,.]\d+)?/);
      const price = Number(priceMatch?.[0].replace(/\s+/g, "").replace(",", "."));

      return {
        article,
        brand: text(".col-md-1.hidden-xs"),
        title: text('[itemprop="name"], .col-md-3.col-xs-8'),
        price,
        warehouse: detail(0),
        quantityText: detail(1),
        deliveryText: detail(2),
      };
    }),
  )) as MladovResultItem[];

  if (!items.length) {
    const bodyText = (await page.locator("body").innerText()).replace(/\s+/g, " ").trim();
    if (isMladovNoResultsPageText(bodyText)) {
      return [];
    }
    throw new SupplierIntegrationError("Механик Ладов вернул нераспознанный пустой результат");
  }

  const target = normalizeArticle(article);
  const validItems = items.filter((item) =>
    item.article && item.brand && item.title && Number.isFinite(item.price) && item.price > 0,
  );
  if (!validItems.length) {
    throw new SupplierIntegrationError("Механик Ладов вернул только некорректные строки результатов");
  }
  const exactItems = validItems.filter((item) => normalizeArticle(item.article) === target);
  return exactItems;
}

export class MladovWebAdapter implements SupplierAdapter {
  readonly id = "mladov";
  readonly displayName = "Механик Ладов";
  readonly timeoutMs = mladovConfig.searchTimeoutMs;

  async ensureSession(sessionManager: SupplierSessionManager): Promise<SupplierSessionState> {
    if (hasMladovStorageState()) {
      return sessionManager.markChecked(this.id, "Сохраненная сессия Механик Ладов доступна");
    }
    if (!sessionManager.getMladovCredentials()) {
      return sessionManager.markUnauthorized(this.id, "Логин и пароль Механик Ладов не настроены");
    }
    return sessionManager.markChecked(this.id, "Учетные данные Механик Ладов доступны");
  }

  async validateSession(context: SupplierSearchContext, _sessionManager: SupplierSessionManager): Promise<void> {
    context.signal.throwIfAborted();
    const browser = await getMladovSharedBrowser(context.signal);
    const browserContext = await createMladovContext(browser, true, context.signal);
    const closeOnAbort = () => browserContext.close().catch(() => undefined);
    context.signal.addEventListener("abort", closeOnAbort, { once: true });
    try {
      const page = await browserContext.newPage();
      if (!await isMladovAuthenticated(page, context.signal)) {
        throw new SupplierAuthError("Сессия Механик Ладов истекла");
      }
    } finally {
      context.signal.removeEventListener("abort", closeOnAbort);
      await browserContext.close().catch(() => undefined);
    }
  }

  async search(
    query: SearchQuery,
    searchContext: SupplierSearchContext,
    onResult: (result: NormalizedSearchResult) => void,
    sessionManager: SupplierSessionManager,
  ): Promise<void> {
    const expectedStateGeneration = getMladovStorageStateGeneration();
    searchContext.signal.throwIfAborted();
    const browser = await getMladovSharedBrowser(searchContext.signal);
    const context = await createMladovContext(browser, true, searchContext.signal);
    const closeOnAbort = () => context.close().catch(() => undefined);
    searchContext.signal.addEventListener("abort", closeOnAbort, { once: true });

    try {
      const page = await context.newPage();
      let authorized = await isMladovAuthenticated(page, searchContext.signal);
      if (!authorized) {
        const credentials = sessionManager.getMladovCredentials();
        if (!credentials) {
          throw new SupplierAuthError("Сессия Механик Ладов истекла, учетные данные отсутствуют");
        }
        const result = await performMladovLogin(page, credentials, searchContext.signal);
        if (!result.authorized) {
          throw new SupplierAuthError(result.details);
        }
        authorized = true;
      }

      if (!authorized) {
        throw new SupplierAuthError("Сессия Механик Ладов не авторизована");
      }

      const article = query.article.trim();
      searchContext.signal.throwIfAborted();
      const items = await fetchMladovResults(context, page, article, searchContext.signal);
      const link = new URL(`/shop.php?artikul=${encodeWindows1251(article)}`, mladovBaseUrl).toString();

      for (const item of items) {
        const delivery = parseDeliveryDate(item.deliveryText);
        onResult({
          supplier: this.id,
          brand: item.brand,
          article: item.article,
          title: item.title,
          price: item.price,
          quantity: parseMladovQuantity(item.quantityText),
          warehouse: item.warehouse,
          deliveryDate: delivery.date,
          deliveryDateApproximate: delivery.approximate,
          link,
        });
      }

      searchContext.signal.throwIfAborted();
      await saveMladovStorageState(context, expectedStateGeneration, searchContext.signal);
    } finally {
      searchContext.signal.removeEventListener("abort", closeOnAbort);
      await context.close().catch(() => undefined);
    }
  }
}
