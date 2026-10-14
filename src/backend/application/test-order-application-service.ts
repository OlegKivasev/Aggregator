import { createBoundedAbortSignal } from "../abort.ts";
import { SupplierAuthError, SupplierTimeoutError } from "../errors.ts";
import type { PurchaseLine, TestOrderLineResult } from "../purchasing/purchase-offer.ts";
import type { SupplierSessionManager } from "../session/session-manager.ts";
import { testArmtekOrder } from "../suppliers/armtek/armtek-test-order.ts";
import { testPartKomOrder } from "../suppliers/part-kom/part-kom-test-order.ts";

export async function testPurchaseOrder(sessionManager: SupplierSessionManager, lines: PurchaseLine[], signal: AbortSignal,
  requests = { armtek: testArmtekOrder, partKom: testPartKomOrder }): Promise<TestOrderLineResult[]> {
  return (await Promise.all((["armtek", "part-kom"] as const).map(async (supplier) => {
    const supplierLines = lines.filter((line) => line.reference.supplier === supplier);
    if (!supplierLines.length) return [];
    const operation = sessionManager.beginOperation(supplier, signal);
    const bounded = createBoundedAbortSignal(operation.signal, 45_000, "Test order timed out");
    try {
      bounded.signal.throwIfAborted();
      if (!sessionManager.getSession(supplier).authorized) throw new SupplierAuthError();
      let results: TestOrderLineResult[];
      if (supplier === "armtek") {
        const credentials = sessionManager.getArmtekCredentials();
        if (!credentials) throw new SupplierAuthError();
        results = await requests.armtek(credentials, supplierLines, bounded.signal);
      } else {
        const credentials = sessionManager.getPartKomCredentials();
        if (!credentials) throw new SupplierAuthError();
        results = await requests.partKom(credentials, supplierLines, bounded.signal);
      }
      bounded.signal.throwIfAborted();
      return results;
    } catch (error) {
      signal.throwIfAborted();
      const message = error instanceof SupplierAuthError ? "Подключите поставщика в настройках и повторите проверку."
        : error instanceof SupplierTimeoutError ? "Поставщик не ответил вовремя. Тестовая проверка не подтверждена."
          : "Не удалось проверить тестовый заказ у поставщика. Повторите поиск и проверьте соединение.";
      return supplierLines.map((line): TestOrderLineResult => ({ id: line.id, status: "unconfirmed", acceptedQuantity: null, message }));
    } finally { bounded.dispose(); operation.dispose(); }
  }))).flat();
}
