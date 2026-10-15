import type { PurchaseLine } from "./purchase-offer.ts";

export type OrderSupplier = PurchaseLine["reference"]["supplier"];

export interface ConfirmedOrderLine {
  id: string;
  acceptedQuantity: number;
  orderIds: string[];
  message?: string;
  partKomOrders?: PartKomOrderReceipt[];
  forumAutoOrder?: ForumAutoOrderReceipt;
}

export interface ForumAutoOrderReceipt {
  orderId: string;
  documentNumber?: string;
  status?: string;
  createdAt?: string;
  deliveryAt?: string;
  brand?: string;
  article?: string;
  title?: string;
  orderedQuantity: number;
  reservedQuantity?: number;
  confirmedQuantity?: number;
  price?: number;
  total?: number;
}

export interface PartKomOrderReceipt {
  orderNumber: string;
  quantity: number;
  orderDate?: string;
  detailNum?: string;
  maker?: string;
  description?: string;
  price?: number;
  stateTxt?: string;
  expectedDate?: string;
  guaranteedDate?: string;
  placement?: string;
  refusalCount?: number;
  storeCount?: number;
  releaseCount?: number;
  comment?: string;
}

export interface OrderGroupResult {
  confirmed: ConfirmedOrderLine[];
  rejected: Array<{ id: string; message: string }>;
}

export interface OrderChoice { id: string; label: string }

export interface RosskoOrderChoices {
  deliveries: Array<OrderChoice & { addressId: string | null }>;
  payments: OrderChoice[];
  companies: OrderChoice[];
}

export interface PartKomOrderChoices {
  deliveries: Array<OrderChoice & { type: "regular" }>;
}

export interface OrderChoices {
  rossko?: RosskoOrderChoices;
  partKom?: PartKomOrderChoices;
}

export interface CheckoutDetails {
  rossko?: { deliveryId: string; addressId: string | null; paymentId: string; companyId: string | null;
    name: string; phone: string; deliveryParts: boolean };
  partKom?: { deliveryId: string };
}
