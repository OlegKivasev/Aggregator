import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { DatabaseSync } from "node:sqlite";
import { NomenclatureError } from "./contract.ts";
import { stockPageSize, type StockPage, type StockResult } from "./stock-contract.ts";

interface Row {
  id: string; cursor: string; query: string; status: string; expires_at: number; lease_id: string | null; result_json: string | null;
}
const ttl = 30_000;

// Only in-progress reads are shared. Every later opening/refresh reads 1C again.
export class StockRequests {
  private readonly changes = new EventEmitter();
  private readonly readers = new Map<string, number>();
  private count = 0;
  private closed = false;
  private readonly database: DatabaseSync;
  private readonly now: () => number;
  constructor(database: DatabaseSync, now: () => number) {
    this.database = database;
    this.now = now;
    this.changes.setMaxListeners(100);
    database.exec(`CREATE TABLE IF NOT EXISTS nomenclature_stock_requests (
      id TEXT PRIMARY KEY, cursor TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, lease_id TEXT, lease_until INTEGER, result_json TEXT, query TEXT NOT NULL DEFAULT ''
    ) STRICT;
    CREATE INDEX IF NOT EXISTS nomenclature_stock_pending_idx ON nomenclature_stock_requests(created_at,id)
      WHERE status IN ('pending','leased');
    CREATE INDEX IF NOT EXISTS nomenclature_stock_expiry_idx ON nomenclature_stock_requests(expires_at);`);
    database.exec("BEGIN IMMEDIATE");
    try {
      if (!database.prepare("PRAGMA table_info(nomenclature_stock_requests)").all().some((column) => column.name === "query")) {
        database.exec("ALTER TABLE nomenclature_stock_requests ADD COLUMN query TEXT NOT NULL DEFAULT ''");
      }
      database.exec(`DROP INDEX IF EXISTS nomenclature_stock_active_idx;
        CREATE UNIQUE INDEX IF NOT EXISTS nomenclature_stock_search_active_idx ON nomenclature_stock_requests(cursor,query)
          WHERE status IN ('pending','leased'); COMMIT`);
    } catch (error) { database.exec("ROLLBACK"); throw error; }
  }
  cleanup(): void {
    this.database.prepare("UPDATE nomenclature_stock_requests SET status='expired' WHERE status IN ('pending','leased') AND expires_at<=?").run(this.now());
    this.database.prepare("DELETE FROM nomenclature_stock_requests WHERE expires_at<?").run(this.now() - 60_000);
  }
  invalidate(): void {
    this.database.exec("UPDATE nomenclature_stock_requests SET status='error', result_json=NULL WHERE status IN ('pending','leased')");
  }
  notify(): void { this.changes.emit("change"); }
  close(): void { this.closed = true; this.notify(); }

  async load(cursor: string | null, signal: AbortSignal, notifyWorker: () => void, query = ""): Promise<StockPage> {
    if (signal.aborted) throw signal.reason;
    if (this.closed) throw new NomenclatureError(503, "stopping", "Соединение закрывается.");
    if (this.count >= 100) throw new NomenclatureError(429, "stock_busy", "Слишком много запросов остатков. Повторите позже.");
    this.cleanup();
    let row = this.database.prepare("SELECT * FROM nomenclature_stock_requests WHERE cursor=? AND query=? AND status IN ('pending','leased')").get(cursor ?? "", query) as unknown as Row | undefined;
    if (!row) {
      const active = this.database.prepare("SELECT COUNT(*) AS count FROM nomenclature_stock_requests WHERE status IN ('pending','leased')").get()!.count;
      if (Number(active) >= 20) throw new NomenclatureError(429, "stock_busy", "Очередь остатков занята. Повторите позже.");
      const id = randomUUID();
      this.database.prepare("INSERT INTO nomenclature_stock_requests (id,cursor,status,created_at,expires_at,query) VALUES (?,?,'pending',?,?,?)")
        .run(id, cursor ?? "", this.now(), this.now() + ttl, query);
      row = this.database.prepare("SELECT * FROM nomenclature_stock_requests WHERE id=?").get(id) as unknown as Row;
      notifyWorker();
    }
    const id = row.id;
    this.count += 1;
    this.readers.set(id, (this.readers.get(id) ?? 0) + 1);
    try {
      return await new Promise<StockPage>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const finish = (error?: unknown, page?: StockPage) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          this.changes.removeListener("change", check);
          if (error) reject(error); else resolve(page!);
        };
        const abort = () => finish(signal.reason);
        const check = (completedId?: string, completedPage?: StockPage) => {
          if (this.closed) return finish(new NomenclatureError(503, "stopping", "Соединение закрывается."));
          if (completedId && completedId !== id) return;
          if (completedPage) return finish(undefined, completedPage);
          const current = this.database.prepare("SELECT * FROM nomenclature_stock_requests WHERE id=?").get(id) as unknown as Row | undefined;
          if (!current || this.now() >= current.expires_at) return finish(new NomenclatureError(504, "stock_timeout", "1С не ответила вовремя. Повторите загрузку остатков."));
          if (current.status === "completed") return finish(undefined, JSON.parse(current.result_json!) as StockPage);
          if (!["pending", "leased"].includes(current.status)) return finish(new NomenclatureError(503, "stock_failed", "Не удалось получить остатки из 1С. Проверьте подключение и обновление расширения."));
        };
        timer = setTimeout(() => finish(new NomenclatureError(504, "stock_timeout", "1С не ответила вовремя. Проверьте подключение и обновление расширения.")), Math.max(1, row!.expires_at - this.now()));
        signal.addEventListener("abort", abort, { once: true });
        this.changes.on("change", check);
        check();
      });
    } finally {
      this.count -= 1;
      const remaining = (this.readers.get(id) ?? 1) - 1;
      if (remaining) this.readers.set(id, remaining);
      else {
        this.readers.delete(id);
        if (!this.closed) this.database.prepare("UPDATE nomenclature_stock_requests SET status='cancelled' WHERE id=? AND status IN ('pending','leased')").run(id);
      }
    }
  }
  claim(supportsSearch = false) {
    this.cleanup();
    const now = this.now();
    const row = this.database.prepare(`UPDATE nomenclature_stock_requests SET status='leased',lease_id=?,lease_until=? WHERE id=(
      SELECT id FROM nomenclature_stock_requests WHERE expires_at>? AND (status='pending' OR status='leased' AND lease_until<=?)
      AND (query='' OR ?=1)
      ORDER BY created_at,id LIMIT 1) RETURNING *`).get(randomUUID(), now + 10_000, now, now, Number(supportsSearch)) as unknown as Row | undefined;
    return row ? { kind: "stock" as const, id: row.id, leaseId: row.lease_id!, after: row.cursor || null,
      ...(supportsSearch ? { query: row.query } : {}),
      limit: stockPageSize, expiresAt: new Date(row.expires_at).toISOString() } : null;
  }
  complete(data: StockResult): void {
    const row = this.database.prepare("SELECT * FROM nomenclature_stock_requests WHERE id=?").get(data.requestId) as unknown as Row | undefined;
    const page: StockPage = { products: data.products, hasMore: data.hasMore,
      nextCursor: data.hasMore ? data.products.at(-1)!.id : null, receivedAt: new Date(this.now()).toISOString() };
    // Keep the timestamp of an accepted result when an identical delivery is retried.
    if (row?.result_json) page.receivedAt = (JSON.parse(row.result_json) as StockPage).receivedAt;
    const result = JSON.stringify(page);
    if (!row || row.lease_id !== data.leaseId) throw new NomenclatureError(409, "lease_mismatch", "Аренда запроса остатков изменилась.");
    if (row.status === data.status && row.result_json === result) return;
    if (row.status !== "leased" || row.expires_at <= this.now() || data.products.some((product) => product.id === row.cursor)) {
      throw new NomenclatureError(409, "stock_finished", "Запрос остатков завершён или истёк.");
    }
    this.database.prepare("UPDATE nomenclature_stock_requests SET status=?,result_json=? WHERE id=?").run(data.status, result, row.id);
    // Deliver the prepared page directly to its readers: no repeated SELECT/JSON.parse per reader.
    this.changes.emit("change", row.id, data.status === "completed" ? page : undefined);
  }
}
