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
      CREATE TABLE IF NOT EXISTS vk_order_notification_welcome (
        target TEXT PRIMARY KEY, message_id INTEGER NOT NULL UNIQUE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS vk_forum_active_orders (
        target TEXT PRIMARY KEY, numbers TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS order_notification_feed (
        id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, payload TEXT NOT NULL, seen_at TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS order_notification_feed_unread ON order_notification_feed(seen_at,id);
      CREATE INDEX IF NOT EXISTS order_notification_feed_priority
        ON order_notification_feed((json_extract(payload, '$.kind') = 'cancelled') DESC,id DESC);
    `); } catch (error) { this.database.close(); throw error; }
  }

  observe(target: string, batches: Array<{ supplier: OrderHistorySupplier; histories: OrderHistory[] }>, now: number): void {
    this.recordObservations(target, batches, now, false);
  }

  observeFeed(batches: Array<{ supplier: OrderHistorySupplier; histories: OrderHistory[] }>, now: number): void {
    this.recordObservations("aggregator-order-feed", batches, now, true);
  }

  private recordObservations(target: string, batches: Array<{ supplier: OrderHistorySupplier; histories: OrderHistory[] }>, now: number, feed: boolean): void {
    const prepared = batches.map(({ supplier, histories }) => ({ supplier, orders: this.combine(histories), complete: histories.length > 0 && histories.every((history) => !history.limited) }));
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const events: OrderEvent[] = [];
      for (const { supplier, orders, complete } of prepared) {
        // Legacy Forum Auto snapshots used mutable document numbers and cannot be matched safely.
        // A new observation namespace establishes a quiet baseline once, independently for each destination.
        const observationTarget = supplier === "forum-auto" ? `${target}:forum-did-v1` : target;
        if (supplier === "forum-auto" && complete) events.push(...this.observeForumActiveOrders(observationTarget, orders));
        const baseline = this.database.prepare("SELECT day FROM vk_order_monitor_baseline WHERE target=? AND supplier=?").get(observationTarget, supplier);
        for (const order of orders) {
          const row = this.database.prepare("SELECT payload FROM vk_order_monitor_snapshot WHERE target=? AND supplier=? AND number=?").get(observationTarget, supplier, order.number);
          const previous = row ? JSON.parse(String(row.payload)) as MonitoredOrder : null;
          // Newly exposed old archive pages are history, not newly placed orders.
          const announceNew = !!baseline && (!order.date || order.date.slice(0, 10) >= String(baseline.day));
          const changes = orderChanges(supplier, order, previous, announceNew);
          events.push(...changes.events);
          this.database.prepare(`INSERT INTO vk_order_monitor_snapshot VALUES (?,?,?,?)
            ON CONFLICT(target,supplier,number) DO UPDATE SET payload=excluded.payload`).run(observationTarget, supplier, order.number, JSON.stringify(changes.snapshot));
        }
        if (!baseline) this.database.prepare("INSERT INTO vk_order_monitor_baseline VALUES (?,?,?)").run(observationTarget, supplier, new Date(now).toISOString().slice(0, 10));
      }
      if (feed) {
        for (const event of events) this.database.prepare("INSERT INTO order_notification_feed(created_at,payload) VALUES (?,?)")
          .run(new Date(now).toISOString(), JSON.stringify(event));
      } else {
        for (const message of formatOrderEvents(events)) this.database.prepare("INSERT INTO vk_order_notification_outbox(random_id,target,text) VALUES (?,?,?)")
          .run(randomInt(1, 2_147_483_647), target, message);
      }
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  feed(before: number | null = null) {
    const rows = before === null
      ? this.database.prepare(`SELECT id,created_at,payload,seen_at FROM order_notification_feed
          ORDER BY (json_extract(payload, '$.kind') = 'cancelled') DESC,id DESC LIMIT 31`).all()
      : this.database.prepare(`SELECT id,created_at,payload,seen_at FROM order_notification_feed
          WHERE (json_extract(payload, '$.kind') = 'cancelled', id) <
            (COALESCE((SELECT json_extract(payload, '$.kind') = 'cancelled' FROM order_notification_feed WHERE id=?), 0), ?)
          ORDER BY (json_extract(payload, '$.kind') = 'cancelled') DESC,id DESC LIMIT 31`).all(before, before);
    const counts = this.database.prepare(`SELECT
      (SELECT COUNT(*) FROM order_notification_feed WHERE seen_at IS NULL) AS unread,
      (SELECT COUNT(*) FROM order_notification_feed WHERE seen_at IS NULL AND json_extract(payload, '$.kind') = 'cancelled') AS cancellations,
      (SELECT MAX(id) FROM order_notification_feed) AS latest`).get();
    const entries = rows.slice(0, 30).map((row) => {
      const event = JSON.parse(String(row.payload)) as OrderEvent;
      return { ...event, items: event.items.slice(0, 100), remainingItems: Math.max(0, event.items.length - 100),
        id: Number(row.id), createdAt: String(row.created_at), read: row.seen_at !== null };
    });
    return { entries, unreadCount: Number(counts?.unread ?? 0), unreadCancellationCount: Number(counts?.cancellations ?? 0), latestId: Number(counts?.latest ?? 0),
      nextBefore: rows.length > 30 ? entries.at(-1)?.id ?? null : null };
  }

  markFeedSeen(throughId: number, now: number): boolean {
    const latest = this.database.prepare("SELECT MAX(id) AS latest FROM order_notification_feed").get();
    if (throughId > Number(latest?.latest ?? 0)) return false;
    this.database.prepare("UPDATE order_notification_feed SET seen_at=? WHERE id<=? AND seen_at IS NULL").run(new Date(now).toISOString(), throughId);
    return true;
  }

  markFeedEntriesSeen(ids: number[], now: number): boolean {
    const placeholders = ids.map(() => "?").join(",");
    const found = this.database.prepare(`SELECT COUNT(*) AS total FROM order_notification_feed WHERE id IN (${placeholders})`).get(...ids);
    if (Number(found?.total) !== ids.length) return false;
    this.database.prepare(`UPDATE order_notification_feed SET seen_at=? WHERE id IN (${placeholders}) AND seen_at IS NULL`)
      .run(new Date(now).toISOString(), ...ids);
    return true;
  }

  private observeForumActiveOrders(target: string, orders: MonitoredOrder[]): OrderEvent[] {
    const row = this.database.prepare("SELECT numbers FROM vk_forum_active_orders WHERE target=?").get(target);
    const current = new Set(orders.map((order) => order.number));
    const events: OrderEvent[] = [];
    if (row) {
      const previous: unknown = JSON.parse(String(row.numbers));
      if (!Array.isArray(previous) || previous.length > 500 || previous.some((number) => typeof number !== "string" || !number || number.length > 200)) throw new Error("Invalid Forum Auto active orders");
      for (const number of previous) {
        if (current.has(number)) continue;
        const stored = this.database.prepare("SELECT payload FROM vk_order_monitor_snapshot WHERE target=? AND supplier='forum-auto' AND number=?").get(target, number);
        if (!stored) throw new Error("Missing Forum Auto order snapshot");
        const order = JSON.parse(String(stored.payload)) as MonitoredOrder;
        events.push({ supplier: "forum-auto", number, kind: "missing", items: Object.values(order.items) });
      }
    }
    // The first complete response establishes current presence, including after upgrading an existing history database.
    this.database.prepare(`INSERT INTO vk_forum_active_orders VALUES (?,?)
      ON CONFLICT(target) DO UPDATE SET numbers=excluded.numbers`).run(target, JSON.stringify([...current]));
    return events;
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

  ensureWelcome(target: string, text: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare("SELECT message_id FROM vk_order_notification_welcome WHERE target=?").get(target);
      if (!existing) {
        const message = this.database.prepare("INSERT INTO vk_order_notification_outbox(random_id,target,text) VALUES (?,?,?)")
          .run(randomInt(1, 2_147_483_647), target, text);
        this.database.prepare("INSERT INTO vk_order_notification_welcome VALUES (?,?)").run(target, message.lastInsertRowid);
      }
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  welcomeState(target: string): "pending" | "sent" | "failed" | null {
    const row = this.database.prepare(`SELECT state FROM vk_order_notification_outbox
      WHERE id=(SELECT message_id FROM vk_order_notification_welcome WHERE target=?)`).get(target);
    if (!row) return null;
    if (row.state !== "pending" && row.state !== "sent" && row.state !== "failed") throw new Error("Invalid welcome message state");
    return row.state;
  }
  retryWelcome(target: string): void {
    this.database.prepare(`UPDATE vk_order_notification_outbox SET state='pending',attempts=0,next_attempt=0
      WHERE id=(SELECT message_id FROM vk_order_notification_welcome WHERE target=?) AND state!='sent'`).run(target);
  }
  forgetWelcome(target: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM vk_order_notification_outbox WHERE id=(SELECT message_id FROM vk_order_notification_welcome WHERE target=?)").run(target);
      this.database.prepare("DELETE FROM vk_order_notification_welcome WHERE target=?").run(target);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  pending(target: string, now: number, welcomeOnly = false, force = false): { id: number; randomId: number; text: string; attempts: number } | null {
    // Preserve order even while the oldest message is waiting for its retry.
    const row = welcomeOnly
      ? this.database.prepare(`SELECT id,random_id,text,attempts,next_attempt FROM vk_order_notification_outbox
        WHERE target=? AND state='pending' AND id=(SELECT message_id FROM vk_order_notification_welcome WHERE target=?)`).get(target, target)
      : this.database.prepare("SELECT id,random_id,text,attempts,next_attempt FROM vk_order_notification_outbox WHERE target=? AND state='pending' ORDER BY id LIMIT 1").get(target);
    if (!row || !force && Number(row.next_attempt) > now) return null;
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
