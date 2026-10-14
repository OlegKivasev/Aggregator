import type { NormalizedSearchResult } from "../types.ts";

export type PurchaseReference =
  | { supplier: "part-kom"; makerId: string; providerId: string }
  | { supplier: "armtek"; keyzak: string };

export interface PurchaseLine {
  id: string;
  result: NormalizedSearchResult;
  quantity: number;
  reference: PurchaseReference;
}

export interface TestOrderLineResult {
  id: string;
  status: "accepted" | "rejected" | "unconfirmed";
  message: string;
  acceptedQuantity: number | null;
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

export function purchaseOfferKey(result: NormalizedSearchResult, reference: PurchaseReference): string {
  return JSON.stringify([reference, result.article, result.brand]);
}
