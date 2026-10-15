import type { PurchaseLine } from "./purchase-offer.ts";

export type OrderSupplier = PurchaseLine["reference"]["supplier"];

export interface ConfirmedOrderLine {
  id: string;
  acceptedQuantity: number;
  orderIds: string[];
  message?: string;
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
