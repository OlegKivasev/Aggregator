import type { SupplierSessionManager } from "../../session/session-manager.ts";
import type { NormalizedSearchResult, SearchQuery, SupplierSearchContext, SupplierSessionState } from "../../types.ts";
import { SupplierAuthError } from "../errors.ts";
import type { SupplierAdapter } from "../supplier-adapter.ts";
import {
  createMladovContext,
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

async function fetchMladovResults(context: any, page: any, article: string): Promise<MladovResultItem[]> {
  const response = await context.request.post(new URL("/ajaxshop3.php", mladovBaseUrl).toString(), {
    form: { artikul: article },
    timeout: Number(process.env.MLADOV_SEARCH_TIMEOUT_MS ?? "15000"),
  });

  if (!response.ok()) {
    throw new Error(`Поиск Механик Ладов вернул HTTP ${response.status()}`);
  }

  const html = new TextDecoder("windows-1251").decode(await response.body());
  await page.setContent(html);
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
        brand: text(".col-md-1.hidden-xs") || "Механик Ладов",
        title: text('[itemprop="name"], .col-md-3.col-xs-8'),
        price,
        warehouse: detail(0),
        deliveryText: detail(2),
      };
    }),
  )) as MladovResultItem[];

  const target = normalizeArticle(article);
  const exactItems = items.filter((item) => normalizeArticle(item.article) === target && Number.isFinite(item.price));
  return exactItems;
}

export class MladovWebAdapter implements SupplierAdapter {
  readonly id = "mladov";
  readonly displayName = "Механик Ладов";
  readonly timeoutMs = Number(process.env.MLADOV_SEARCH_TIMEOUT_MS ?? "20000");

  async ensureSession(sessionManager: SupplierSessionManager): Promise<SupplierSessionState> {
    if (hasMladovStorageState()) {
      return sessionManager.markChecked(this.id, "Сохраненная сессия Механик Ладов доступна");
    }
    if (!sessionManager.getMladovCredentials()) {
      return sessionManager.markUnauthorized(this.id, "Логин и пароль Механик Ладов не настроены");
    }
    return sessionManager.markChecked(this.id, "Учетные данные Механик Ладов доступны");
  }

  async search(
    query: SearchQuery,
    searchContext: SupplierSearchContext,
    onResult: (result: NormalizedSearchResult) => void,
    sessionManager: SupplierSessionManager,
  ): Promise<void> {
    const browser = await getMladovSharedBrowser();
    const context = await createMladovContext(browser);
    const page = await context.newPage();
    const closeOnAbort = () => context.close().catch(() => undefined);
    searchContext.signal.addEventListener("abort", closeOnAbort, { once: true });

    try {
      let authorized = await isMladovAuthenticated(page);
      if (!authorized) {
        const credentials = sessionManager.getMladovCredentials();
        if (!credentials) {
          throw new SupplierAuthError("Сессия Механик Ладов истекла, учетные данные отсутствуют");
        }
        const result = await performMladovLogin(page, credentials);
        if (!result.authorized) {
          throw new SupplierAuthError(result.details);
        }
        authorized = true;
      }

      if (!authorized) {
        throw new SupplierAuthError("Сессия Механик Ладов не авторизована");
      }

      const article = query.article.trim();
      const items = await fetchMladovResults(context, page, article);
      const link = new URL(`/shop.php?artikul=${encodeWindows1251(article)}`, mladovBaseUrl).toString();

      for (const item of items) {
        const delivery = parseDeliveryDate(item.deliveryText);
        onResult({
          supplier: this.id,
          brand: item.brand,
          article: item.article,
          title: item.title || item.article,
          price: item.price,
          warehouse: item.warehouse,
          deliveryDate: delivery.date,
          deliveryDateApproximate: delivery.approximate,
          link,
        });
      }

      await saveMladovStorageState(context);
    } finally {
      searchContext.signal.removeEventListener("abort", closeOnAbort);
      await context.close().catch(() => undefined);
    }
  }
}
