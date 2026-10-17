import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomInt } from "node:crypto";
import type { OrderHistory } from "../purchasing/order-history-contract.ts";
import type { OrderHistorySupplier } from "../purchasing/order-cancellation-contract.ts";
import { formatOrderEvents, monitoredOrders, orderChanges, type MonitoredOrder, type OrderEvent } from "./order-events.ts";

export class SqliteNotificationRepository {
  private readonly database: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    try { this.database.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS vk_order_monitor_baseline (target TEXT NOT NULL, supplier TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY(target,supplier)) STRICT;
      CREATE TABLE IF NOT EXISTS vk_order_monitor_snapshot (target TEXT NOT NULL, supplier TEXT NOT NULL, number TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(target,supplier,number)) STRICT;
      CREATE TABLE IF NOT EXISTS vk_order_notification_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, random_id INTEGER NOT NULL UNIQUE, target TEXT NOT NULL, text TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent','failed'))
      ) STRICT;
    `); } catch (error) { this.database.close(); throw error; }
  }

  observe(target: string, batches: Array<{ supplier: OrderHistorySupplier; histories: OrderHistory[] }>, now: number): void {
    const prepared = batches.map(({ supplier, histories }) => ({ supplier, orders: this.combine(histories) }));
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const events: OrderEvent[] = [];
      for (const { supplier, orders } of prepared) {
        const baseline = this.database.prepare("SELECT day FROM vk_order_monitor_baseline WHERE target=? AND supplier=?").get(target, supplier);
        for (const order of orders) {
          const row = this.database.prepare("SELECT payload FROM vk_order_monitor_snapshot WHERE target=? AND supplier=? AND number=?").get(target, supplier, order.number);
          const previous = row ? JSON.parse(String(row.payload)) as MonitoredOrder : null;
          // Newly exposed old archive pages are history, not newly placed orders.
          const announceNew = !!baseline && (!order.date || order.date.slice(0, 10) >= String(baseline.day));
          const changes = orderChanges(supplier, order, previous, announceNew);
          events.push(...changes.events);
          this.database.prepare(`INSERT INTO vk_order_monitor_snapshot VALUES (?,?,?,?)
            ON CONFLICT(target,supplier,number) DO UPDATE SET payload=excluded.payload`).run(target, supplier, order.number, JSON.stringify(changes.snapshot));
        }
        if (!baseline) this.database.prepare("INSERT INTO vk_order_monitor_baseline VALUES (?,?,?)").run(target, supplier, new Date(now).toISOString().slice(0, 10));
      }
      for (const message of formatOrderEvents(events)) this.database.prepare("INSERT INTO vk_order_notification_outbox(random_id,target,text) VALUES (?,?,?)")
        .run(randomInt(1, 2_147_483_647), target, message);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  private combine(histories: OrderHistory[]): MonitoredOrder[] {
    const combined = new Map<string, MonitoredOrder>();
    for (const history of histories) for (const order of monitoredOrders(history)) {
      const previous = combined.get(order.number);
      if (!previous) { combined.set(order.number, order); continue; }
      for (const [key, item] of Object.entries(order.items)) {
        const before = previous.items[key];
        // Current/archive queries may overlap. Never add the same part twice across feeds.
        previous.items[key] = before ? { ...item, quantity: Math.max(item.quantity, before.quantity),
          cancelled: Math.max(item.cancelled, before.cancelled), received: Math.max(item.received, before.received),
          price: before.price === item.price ? item.price : null } : item;
      }
    }
    return [...combined.values()];
  }

  pending(target: string, now: number): { id: number; randomId: number; text: string; attempts: number } | null {
    // Preserve order even while the oldest message is waiting for its retry.
    const row = this.database.prepare("SELECT id,random_id,text,attempts,next_attempt FROM vk_order_notification_outbox WHERE target=? AND state='pending' ORDER BY id LIMIT 1").get(target);
    if (!row || Number(row.next_attempt) > now) return null;
    const id = Number(row.id);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("Notification identifier limit reached");
    return { id, randomId: Number(row.random_id), text: String(row.text), attempts: Number(row.attempts) };
  }

  sent(id: number): void { this.database.prepare("UPDATE vk_order_notification_outbox SET state='sent' WHERE id=?").run(id); }
  retryFailed(target: string): void {
    this.database.prepare("UPDATE vk_order_notification_outbox SET state='pending',attempts=0,next_attempt=0 WHERE target=? AND state='failed'").run(target);
  }
  retry(id: number, attempts: number, now: number, permanent: boolean): void {
    this.database.prepare("UPDATE vk_order_notification_outbox SET attempts=?,next_attempt=?,state=? WHERE id=?")
      .run(attempts + 1, now + Math.min(3_600_000, 30_000 * 2 ** Math.min(attempts, 7)), permanent || attempts >= 9 ? "failed" : "pending", id);
  }
  counts(target: string): { pending: number; failed: number } {
    const row = this.database.prepare("SELECT SUM(state='pending') AS pending,SUM(state='failed') AS failed FROM vk_order_notification_outbox WHERE target=?").get(target);
    return { pending: Number(row?.pending ?? 0), failed: Number(row?.failed ?? 0) };
  }
  close(): void { this.database.close(); }
}
