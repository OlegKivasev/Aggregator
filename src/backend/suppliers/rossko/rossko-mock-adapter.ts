import type { SupplierSessionManager } from "../../session/session-manager.ts";
import type {
  NormalizedSearchResult,
  SearchQuery,
  SupplierSearchContext,
  SupplierSessionState,
} from "../../types.ts";
import type { SupplierAdapter } from "../supplier-adapter.ts";

const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abortHandler = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };

    signal.addEventListener("abort", abortHandler, { once: true });
  });

const buildLink = (article: string) =>
  `https://example.com/rossko/search?article=${encodeURIComponent(article)}`;

export class RosskoMockAdapter implements SupplierAdapter {
  readonly id = "rossko";
  readonly displayName = "Rossko";
  readonly timeoutMs = 15000;

  async ensureSession(sessionManager: SupplierSessionManager): Promise<SupplierSessionState> {
    const existing = sessionManager.getSession(this.id);

    if (existing.authorized) {
      return sessionManager.markChecked(this.id, "Using in-memory stub session");
    }

    return sessionManager.markAuthorized(this.id, "Stub session bootstrapped for scaffold stage");
  }

  async search(
    query: SearchQuery,
    context: SupplierSearchContext,
    onResult: (result: NormalizedSearchResult) => void,
  ): Promise<void> {
    const normalizedArticle = query.article.trim().toUpperCase();

    const mockResults: NormalizedSearchResult[] = [
      {
        supplier: this.id,
        brand: "Rossko",
        article: normalizedArticle,
        title: `Rossko mock result A for ${normalizedArticle}`,
        price: 1240,
        warehouse: "Москва",
        deliveryDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        deliveryDateApproximate: false,
        link: buildLink(normalizedArticle),
      },
      {
        supplier: this.id,
        brand: "Rossko",
        article: normalizedArticle,
        title: `Rossko mock result B for ${normalizedArticle}`,
        price: 980,
        warehouse: "Санкт-Петербург",
        deliveryDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
        deliveryDateApproximate: false,
        link: buildLink(normalizedArticle),
      },
      {
        supplier: this.id,
        brand: "Rossko",
        article: normalizedArticle,
        title: `Rossko mock result C for ${normalizedArticle}`,
        price: 1620,
        warehouse: null,
        deliveryDate: new Date().toISOString(),
        deliveryDateApproximate: false,
        link: buildLink(normalizedArticle),
      },
    ];

    for (const [index, result] of mockResults.entries()) {
      await delay(350 + index * 450, context.signal);
      onResult(result);
    }
  }
}
