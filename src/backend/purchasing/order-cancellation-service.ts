import type { OrderHistory, OrderHistoryItem } from "./order-history-contract.ts";
import type { CancellationGroup, CancellationSnapshot, OrderHistorySupplier } from "./order-cancellation-contract.ts";
import type { SqliteOrderCancellationRepository } from "./sqlite-order-cancellation-repository.ts";

export class CancellationInputError extends Error {}

export class OrderCancellationService {
  private readonly repository: SqliteOrderCancellationRepository;

  constructor(repository: SqliteOrderCancellationRepository) { this.repository = repository; }

  observe(supplier: OrderHistorySupplier, history: OrderHistory): void {
    if (!Array.isArray(history?.orders)) return;
    const snapshots: CancellationSnapshot[] = [];
    for (const order of history.orders) {
      if (typeof order?.number !== "string" || !Array.isArray(order.items)) continue;
      const groups = new Map<string, CancellationGroup>();
      for (const item of order.items) {
        if (!item || !["cancelled", "partially_cancelled", "partial"].includes(item.fulfillment)) continue;
        const quantity = item.fulfillment === "cancelled" ? item.quantity : item.cancelledQuantity ?? item.fulfillmentQuantities?.cancelled;
        if (typeof item.article !== "string" || !Number.isFinite(item.quantity) || typeof quantity !== "number"
          || !Number.isFinite(quantity) || quantity <= 0 || quantity > item.quantity) continue;
        const cancelled: OrderHistoryItem = { article: item.article, brand: item.brand, title: item.title, quantity,
          price: item.price, status: `Отменено ${quantity} шт.`, fulfillment: "cancelled", cancelledQuantity: quantity,
          expectedDate: item.expectedDate, guaranteedDate: item.guaranteedDate, warehouse: item.warehouse,
          ...(item.returnDays === undefined ? {} : { returnDays: item.returnDays }) };
        // Suppliers without position IDs are compared by total cancellations of the same part.
        // Row order, descriptions, prices and warehouse renaming must not generate new alerts.
        const key = JSON.stringify(item.positionId ? ["position", item.positionId]
          : ["part", item.brand?.toLocaleUpperCase() ?? null, item.article.toLocaleUpperCase()]);
        const group = groups.get(key);
        if (group) { group.quantity += quantity; group.items.push(cancelled); }
        else groups.set(key, { quantity, items: [cancelled] });
      }
      if (groups.size) snapshots.push({ number: order.number, date: order.date, groups: Object.fromEntries(groups) });
    }
    if (snapshots.length) this.repository.observe(supplier, snapshots);
  }

  unread() { return this.repository.unread(); }

  acknowledge(payload: unknown) {
    const notices = payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { notices?: unknown }).notices : null;
    if (!Array.isArray(notices) || !notices.length || notices.length > 100) throw new CancellationInputError();
    const ids = new Set<string>();
    const validated = notices.map((notice: unknown) => {
      if (!notice || typeof notice !== "object" || Array.isArray(notice)) throw new CancellationInputError();
      const { id, revision } = notice as { id?: unknown; revision?: unknown };
      if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
        || ids.has(id) || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) throw new CancellationInputError();
      ids.add(id);
      return { id, revision };
    });
    this.repository.acknowledge(validated);
    return this.unread();
  }

  close(): void { this.repository.close(); }
}
