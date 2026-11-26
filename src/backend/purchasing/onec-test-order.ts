import { randomUUID } from "node:crypto";
import type { PurchaseLine, PurchaseReference } from "./purchase-offer.ts";

interface TestSupplierOrder {
  format: "aggregator.supplier-order";
  version: 1;
  testOnly: true;
  id: string;
  number: string;
  supplier: PurchaseReference["supplier"];
  createdAt: string;
  currency: "RUB";
  items: Array<{
    article: string;
    brand: string;
    title: string;
    quantity: number;
    price: number;
    deliveryDate: string | null;
    returnDays: number | null;
  }>;
}

export function makeTestSupplierOrders(lines: PurchaseLine[]): TestSupplierOrder[] {
  const createdAt = new Date().toISOString();
  const orders = new Map<PurchaseReference["supplier"], TestSupplierOrder>();
  for (const { reference, result, quantity } of lines) {
    let order = orders.get(reference.supplier);
    if (!order) {
      const id = randomUUID();
      order = {
        format: "aggregator.supplier-order", version: 1, testOnly: true,
        id, number: `TEST-${id.replaceAll("-", "").slice(0, 20).toUpperCase()}`,
        supplier: reference.supplier, createdAt, currency: "RUB", items: [],
      };
      orders.set(reference.supplier, order);
    }
    order.items.push({
      article: result.article,
      brand: result.brand,
      title: result.title,
      quantity,
      price: result.price,
      deliveryDate: result.deliveryDate?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null,
      returnDays: reference.supplier === "armtek" ? reference.returnDays ?? null : null,
    });
  }
  return [...orders.values()];
}
