import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { PurchaseLine } from "./purchase-offer.ts";
import type { ArmtekOrderReceipt } from "./order-contract.ts";

export interface StoredCart {
  revision: number;
  lines: PurchaseLine[];
}

export class SqliteCartRepository {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS purchase_cart (
        id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, payload TEXT NOT NULL
      ) STRICT;
      INSERT OR IGNORE INTO purchase_cart VALUES (1, 0, '[]');
      CREATE TABLE IF NOT EXISTS purchase_order_attempt (
        id TEXT PRIMARY KEY, supplier TEXT NOT NULL, line_ids TEXT NOT NULL,
        started_at TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending', 'uncertain'))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS purchase_order_resolution (
        attempt_id TEXT PRIMARY KEY, resolved_at TEXT NOT NULL,
        resolution TEXT NOT NULL CHECK (resolution = 'customer_verified_missing')
      ) STRICT;
      CREATE TABLE IF NOT EXISTS purchase_armtek_return_terms (
        order_number TEXT NOT NULL, position_id TEXT NOT NULL,
        article TEXT NOT NULL, brand TEXT NOT NULL,
        return_days INTEGER NOT NULL CHECK (return_days BETWEEN 0 AND 9999),
        PRIMARY KEY (order_number, position_id)
      ) STRICT;
    `);
  }

  load(): StoredCart {
    const row = this.database.prepare("SELECT revision, payload FROM purchase_cart WHERE id = 1").get();
    if (!row || typeof row.revision !== "number" || typeof row.payload !== "string") throw new Error("Invalid cart storage");
    const lines: unknown = JSON.parse(row.payload);
    // Server-owned storage; restored rows are validated by the application service.
    if (!Array.isArray(lines)) throw new Error("Invalid cart storage");
    return { revision: row.revision, lines: lines as PurchaseLine[] };
  }

  save(cart: StoredCart, previousRevision: number): boolean {
    return this.database.prepare("UPDATE purchase_cart SET revision = ?, payload = ? WHERE id = 1 AND revision = ?")
      .run(cart.revision, JSON.stringify(cart.lines), previousRevision).changes === 1;
  }

  pendingLineIds(): string[] {
    const rows = this.database.prepare(`SELECT line_ids FROM purchase_order_attempt AS attempt
      WHERE NOT EXISTS (SELECT 1 FROM purchase_order_resolution AS resolution WHERE resolution.attempt_id = attempt.id)`).all();
    return rows.flatMap((row) => {
      if (typeof row.line_ids !== "string") throw new Error("Invalid order attempt storage");
      const value: unknown = JSON.parse(row.line_ids);
      if (!Array.isArray(value) || !value.every((id) => typeof id === "string")) throw new Error("Invalid order attempt storage");
      return value as string[];
    });
  }

  beginOrder(supplier: string, lineIds: string[]): string {
    const id = randomUUID();
    this.database.prepare("INSERT INTO purchase_order_attempt (id, supplier, line_ids, started_at, state) VALUES (?, ?, ?, ?, 'pending')")
      .run(id, supplier, JSON.stringify(lineIds), new Date().toISOString());
    return id;
  }

  finishOrder(attemptId: string, confirmed: Array<{ id: string; acceptedQuantity: number; armtekOrders?: ArmtekOrderReceipt[] }>): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const cart = this.load();
      for (const item of confirmed) {
        const line = cart.lines.find((candidate) => candidate.id === item.id);
        if (!line || !Number.isSafeInteger(item.acceptedQuantity) || item.acceptedQuantity < 1 || item.acceptedQuantity > line.quantity) {
          throw new Error("Confirmed order does not match cart");
        }
        if (line.reference.supplier === "armtek") {
          for (const receipt of item.armtekOrders ?? []) {
            if (!receipt.positionId || receipt.returnDays === undefined || !Number.isInteger(receipt.returnDays)
              || receipt.returnDays < 0 || receipt.returnDays > 9999) continue;
            this.database.prepare(`INSERT OR IGNORE INTO purchase_armtek_return_terms
              (order_number, position_id, article, brand, return_days) VALUES (?, ?, ?, ?, ?)`)
              .run(receipt.orderId, receipt.positionId, line.result.article, line.result.brand, receipt.returnDays);
          }
        }
        line.quantity -= item.acceptedQuantity;
      }
      cart.lines = cart.lines.filter((line) => line.quantity > 0);
      if (confirmed.length && !this.save({ ...cart, revision: cart.revision + 1 }, cart.revision)) throw new Error("Cart revision changed during order");
      if (this.database.prepare("DELETE FROM purchase_order_attempt WHERE id = ? AND state = 'pending'").run(attemptId).changes !== 1) {
        throw new Error("Order attempt is missing");
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  markOrderUncertain(attemptId: string): void {
    this.database.prepare("UPDATE purchase_order_attempt SET state = 'uncertain' WHERE id = ?").run(attemptId);
  }

  armtekReturnDays(orderNumber: string, positionId: string, article: string, brand: string | null): number | null {
    if (!brand) return null;
    const row = this.database.prepare(`SELECT return_days FROM purchase_armtek_return_terms
      WHERE order_number = ? AND position_id = ? AND article = ? AND brand = ?`)
      .get(orderNumber, positionId, article, brand);
    return typeof row?.return_days === "number" ? row.return_days : null;
  }

  resolveUncertainForumAutoLine(lineId: string, revision: number): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const cart = this.load();
      if (cart.revision !== revision || !cart.lines.some((line) => line.id === lineId && line.reference.supplier === "forum-auto")) {
        this.database.exec("ROLLBACK");
        return false;
      }
      const rows = this.database.prepare(`SELECT id, line_ids FROM purchase_order_attempt AS attempt
        WHERE supplier = 'forum-auto' AND state = 'uncertain'
        AND NOT EXISTS (SELECT 1 FROM purchase_order_resolution AS resolution WHERE resolution.attempt_id = attempt.id)`).all();
      const matches = rows.filter((row) => {
        if (typeof row.id !== "string" || typeof row.line_ids !== "string") throw new Error("Invalid order attempt storage");
        const value: unknown = JSON.parse(row.line_ids);
        if (!Array.isArray(value) || !value.every((id) => typeof id === "string")) throw new Error("Invalid order attempt storage");
        return value.includes(lineId);
      });
      if (matches.length !== 1) {
        this.database.exec("ROLLBACK");
        return false;
      }
      this.database.prepare("INSERT INTO purchase_order_resolution (attempt_id, resolved_at, resolution) VALUES (?, ?, 'customer_verified_missing')")
        .run(matches[0].id, new Date().toISOString());
      if (!this.save({ ...cart, revision: revision + 1 }, revision)) throw new Error("Cart revision changed during order resolution");
      this.database.exec("COMMIT");
      return true;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void { this.database.close(); }
}
