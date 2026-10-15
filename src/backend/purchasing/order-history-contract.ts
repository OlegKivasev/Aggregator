export interface OrderHistoryItem {
  article: string;
  brand: string | null;
  title: string | null;
  quantity: number;
  price: number | null;
  status: string | null;
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
