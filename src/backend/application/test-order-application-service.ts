import type { PurchaseLine, TestOrderLineResult } from "../purchasing/purchase-offer.ts";

// Explicitly requested demo workflow: no supplier calls, authorization or inventory confirmation.
export async function testPurchaseOrder(lines: PurchaseLine[], signal: AbortSignal): Promise<TestOrderLineResult[]> {
  signal.throwIfAborted();
  return lines.map((line) => ({
    id: line.id,
    status: "simulated",
    acceptedQuantity: null,
    message: "Тестовый заказ успешно завершён. Поставщику не отправлен.",
  }));
}
