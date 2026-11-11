import type { NormalizedSearchResult } from "../types.ts";
import { additionalArticleVariants } from "../article-search-variants.ts";

export type PurchaseReference =
  | { supplier: "part-kom"; makerId: string; providerId: string }
  | { supplier: "armtek"; keyzak: string; returnDays?: number }
  | { supplier: "forum-auto"; warehouse: string | null; gid?: string }
  | { supplier: "autopiter"; detailUid: string; sellerId: string }
  | { supplier: "rossko"; partGuid: string | null; stockId: string | null };

export interface PurchaseLine {
  id: string;
  result: NormalizedSearchResult;
  quantity: number;
  reference: PurchaseReference;
}

export interface TestOrderLineResult {
  id: string;
  status: "simulated";
  message: string;
  acceptedQuantity: null;
}

export type TestOrder = (lines: PurchaseLine[], signal: AbortSignal) => Promise<TestOrderLineResult[]>;

// Supplier routing identifiers remain on the server; the public search payload stays unchanged.
const references = new WeakMap<NormalizedSearchResult, PurchaseReference>();

export function attachPurchaseReference(result: NormalizedSearchResult, reference: PurchaseReference): NormalizedSearchResult {
  if (result.supplier !== reference.supplier) throw new Error("Purchase supplier mismatch");
  references.set(result, reference);
  return result;
}

export function getPurchaseReference(result: NormalizedSearchResult): PurchaseReference | null {
  return references.get(result) ?? null;
}

export function samePurchaseArticle(left: string, right: string): boolean {
  const key = (article: string): string => article.replace(/[^\p{L}\p{N}]/gu, "").toLocaleUpperCase();
  return [left, ...additionalArticleVariants(left).map((variant) => variant.article)]
    .some((article) => key(article) === key(right));
}

export function samePurchaseOffer(
  current: { result: Pick<NormalizedSearchResult, "article" | "brand">; reference: PurchaseReference },
  fresh: { result: Pick<NormalizedSearchResult, "article" | "brand">; reference: PurchaseReference },
): boolean {
  if (!samePurchaseArticle(current.result.article, fresh.result.article)
    || current.result.brand.trim().toLocaleUpperCase() !== fresh.result.brand.trim().toLocaleUpperCase()
    || current.reference.supplier !== fresh.reference.supplier) return false;
  const old = current.reference;
  const next = fresh.reference;
  if (old.supplier === "armtek" && next.supplier === "armtek") return old.keyzak === next.keyzak;
  if (old.supplier === "part-kom" && next.supplier === "part-kom") return old.makerId === next.makerId && old.providerId === next.providerId;
  if (old.supplier === "autopiter" && next.supplier === "autopiter") return old.detailUid === next.detailUid && old.sellerId === next.sellerId;
  if (old.supplier === "forum-auto" && next.supplier === "forum-auto") {
    return old.gid ? old.gid === next.gid : old.warehouse === next.warehouse;
  }
  return old.supplier === "rossko" && next.supplier === "rossko" && old.stockId === next.stockId
    && old.partGuid === next.partGuid;
}

export function purchaseOfferKey(result: NormalizedSearchResult, reference: PurchaseReference): string {
  const identity = reference.supplier === "armtek" ? { supplier: reference.supplier, keyzak: reference.keyzak } : reference;
  return JSON.stringify([identity, result.article, result.brand,
    ...(reference.supplier === "forum-auto" || reference.supplier === "rossko"
      ? [result.warehouse] : [])]);
}
