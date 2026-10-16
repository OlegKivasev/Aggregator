import type { OrderHistoryItem, OrderHistoryOrder } from "./order-history-contract.ts";

export type OrderHistorySupplier = "part-kom" | "armtek" | "forum-auto" | "rossko";

export interface CancellationGroup {
  quantity: number;
  items: OrderHistoryItem[];
}

export interface CancellationSnapshot {
  number: string;
  date: string | null;
  groups: Record<string, CancellationGroup>;
}

export interface OrderCancellationNotice {
  id: string;
  supplier: OrderHistorySupplier;
  revision: number;
  detectedAt: string;
  order: OrderHistoryOrder;
}

export interface OrderCancellationPage {
  notices: OrderCancellationNotice[];
  total: number;
}
