import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import type { SupplierId } from "../types.ts";
import type { SupplierCounterparty } from "./supplier-orders-contract.ts";

type CounterpartyMapping = SupplierCounterparty & { supplier: SupplierId };

export class SupplierCounterparties {
  private readonly database: DatabaseSync;
  private readonly changes = new EventEmitter().setMaxListeners(100);

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    try {
      this.database.exec(`PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS supplier_counterparties (
          supplier TEXT PRIMARY KEY, id TEXT NOT NULL, name TEXT NOT NULL, taxId TEXT NOT NULL
        ) STRICT, WITHOUT ROWID;`);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  close() { this.database.close(); }

  list(): CounterpartyMapping[] {
    return this.database.prepare("SELECT supplier, id, name, taxId FROM supplier_counterparties").all() as unknown as CounterpartyMapping[];
  }

  ids(): Record<string, string> {
    return Object.fromEntries(this.list().map(({ supplier, id }) => [supplier, id]));
  }

  save(supplier: SupplierId, entry: SupplierCounterparty | null): void {
    if (entry) {
      this.database.prepare(`INSERT INTO supplier_counterparties (supplier, id, name, taxId) VALUES (?, ?, ?, ?)
        ON CONFLICT(supplier) DO UPDATE SET id=excluded.id, name=excluded.name, taxId=excluded.taxId`)
        .run(supplier, entry.id, entry.name, entry.taxId);
    } else {
      this.database.prepare("DELETE FROM supplier_counterparties WHERE supplier=?").run(supplier);
    }
    if (this.changes.listenerCount("mappings")) this.changes.emit("mappings", this.ids());
  }

  subscribe(listener: (ids: Record<string, string>) => void): (() => void) | null {
    if (this.changes.listenerCount("mappings") >= 100) return null;
    this.changes.on("mappings", listener);
    return () => this.changes.off("mappings", listener);
  }
}
