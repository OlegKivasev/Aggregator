export type OrderFulfillment = "processing" | "in_transit" | "ready" | "delivered" | "cancelled" | "partially_cancelled" | "partial" | "returned" | "unknown";

export interface OrderHistoryItem {
  positionId?: string;
  /** Armtek offer terms saved when this position was ordered through the aggregator. */
  returnDays?: number;
  article: string;
  brand: string | null;
  title: string | null;
  quantity: number;
  price: number | null;
  status: string | null;
  fulfillment: OrderFulfillment;
  /** Confirmed quantities of a settled position with both receipt and cancellation. */
  fulfillmentQuantities?: { delivered: number; cancelled: number };
  /** Confirmed cancellation count, including a position that is still partly pending. */
  cancelledQuantity?: number;
  expectedDate: string | null;
  guaranteedDate: string | null;
  warehouse: string | null;
}

export interface OrderHistoryOrder {
  number: string;
  date: string | null;
  items: OrderHistoryItem[];
}

export interface OrderHistory {
  orders: OrderHistoryOrder[];
  limited: boolean;
}

export type SupplierOrderHistoryQuery =
  | { supplier: "armtek"; from: string; to: string }
  | { supplier: "forum-auto" | "rossko" };
