import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { CancellationSnapshot, OrderCancellationPage, OrderHistorySupplier } from "./order-cancellation-contract.ts";

export class SqliteOrderCancellationRepository {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    try { this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS purchase_order_cancellation (
        id TEXT PRIMARY KEY, supplier TEXT NOT NULL, order_number TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0), seen_revision INTEGER NOT NULL DEFAULT 0,
        detected_at TEXT NOT NULL, payload TEXT NOT NULL,
        UNIQUE (supplier, order_number)
      ) STRICT;
    `); } catch (error) { this.database.close(); throw error; }
  }

  observe(supplier: OrderHistorySupplier, snapshots: CancellationSnapshot[]): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const incoming of snapshots) {
        const row = this.database.prepare("SELECT id, revision, payload FROM purchase_order_cancellation WHERE supplier = ? AND order_number = ?")
          .get(supplier, incoming.number);
        // Only this repository writes the serialized snapshot; corrupt storage fails explicitly.
        const previous = row ? JSON.parse(String(row.payload)) as CancellationSnapshot : null;
        const groups = { ...previous?.groups };
        let changed = false;
        for (const [key, group] of Object.entries(incoming.groups)) {
          if (group.quantity > (groups[key]?.quantity ?? 0)) { groups[key] = group; changed = true; }
        }
        // A shorter supplier response does not revoke an already observed cancellation.
        if (!changed) continue;
        const snapshot: CancellationSnapshot = { number: incoming.number, date: incoming.date ?? previous?.date ?? null, groups };
        this.database.prepare(`INSERT INTO purchase_order_cancellation
          (id, supplier, order_number, revision, seen_revision, detected_at, payload) VALUES (?, ?, ?, 1, 0, ?, ?)
          ON CONFLICT (supplier, order_number) DO UPDATE SET
            revision = revision + 1, detected_at = excluded.detected_at, payload = excluded.payload`)
          .run(row ? String(row.id) : randomUUID(), supplier, incoming.number, new Date().toISOString(), JSON.stringify(snapshot));
      }
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  unread(): OrderCancellationPage {
    const total = this.database.prepare("SELECT COUNT(*) AS total FROM purchase_order_cancellation WHERE revision > seen_revision").get();
    const rows = this.database.prepare(`SELECT id, supplier, revision, detected_at, payload FROM purchase_order_cancellation
      WHERE revision > seen_revision ORDER BY detected_at DESC, id LIMIT 100`).all();
    return { total: Number(total?.total), notices: rows.map((row) => {
      const snapshot = JSON.parse(String(row.payload)) as CancellationSnapshot;
      return { id: String(row.id), supplier: String(row.supplier) as OrderHistorySupplier, revision: Number(row.revision),
        detectedAt: String(row.detected_at), order: { number: snapshot.number, date: snapshot.date,
          items: Object.values(snapshot.groups).flatMap((group) => group.items) } };
    }) };
  }

  acknowledge(notices: Array<{ id: string; revision: number }>): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const notice of notices) {
        this.database.prepare(`UPDATE purchase_order_cancellation SET seen_revision = MAX(seen_revision, ?)
          WHERE id = ? AND revision >= ?`).run(notice.revision, notice.id, notice.revision);
      }
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  close(): void { this.database.close(); }
}
