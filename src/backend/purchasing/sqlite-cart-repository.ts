import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { PurchaseLine } from "./purchase-offer.ts";

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
    const rows = this.database.prepare("SELECT line_ids FROM purchase_order_attempt").all();
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

  finishOrder(attemptId: string, confirmed: Array<{ id: string; acceptedQuantity: number }>): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const cart = this.load();
      for (const item of confirmed) {
        const line = cart.lines.find((candidate) => candidate.id === item.id);
        if (!line || !Number.isSafeInteger(item.acceptedQuantity) || item.acceptedQuantity < 1 || item.acceptedQuantity > line.quantity) {
          throw new Error("Confirmed order does not match cart");
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

  close(): void { this.database.close(); }
}
