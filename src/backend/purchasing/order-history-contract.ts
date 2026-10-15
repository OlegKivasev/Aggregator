export interface PartKomHistoryItem {
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

export interface PartKomHistoryOrder {
  number: string;
  date: string | null;
  items: PartKomHistoryItem[];
}

export interface PartKomOrderHistory {
  orders: PartKomHistoryOrder[];
  limited: boolean;
}
