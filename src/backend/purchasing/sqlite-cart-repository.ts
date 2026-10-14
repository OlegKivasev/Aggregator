import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

  close(): void { this.database.close(); }
}
