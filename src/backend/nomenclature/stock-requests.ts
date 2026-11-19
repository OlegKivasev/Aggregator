import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { DatabaseSync } from "node:sqlite";
import { NomenclatureError } from "./contract.ts";
import { stockPageSize, type StockPage, type StockResult } from "./stock-contract.ts";
import { defaultStockSort, decodeStockCursor, encodeStockCursor, validateStockSortValue, type StockSort, type StockSortField } from "./stock-sort.ts";
import { stockOptionsKey, type StockOptions } from "./stock-options.ts";

interface Row {
  id: string; cursor: string; query: string; status: string; expires_at: number; lease_id: string | null; result_json: string | null;
  sort_field: StockSortField; sort_direction: "asc" | "desc";
  options: string;
}
const ttl = 30_000;

// The FIFO peek and atomic lease must use identical capability rules.
export const stockWorkerConditions = `AND (query='' OR ?=1)
  AND (query NOT LIKE '% %' OR ?=1)
  AND (sort_field='id' OR ?=1)
  AND (options='' OR ?=1)
  AND (options='' OR json_extract(NULLIF(options, ''), '$.searchMode') IS NULL OR ?=1)
  AND (options='' OR json_extract(NULLIF(options, ''), '$.inventory') IS NULL OR ?=1)
  AND (options='' OR json_extract(NULLIF(options, ''), '$.incomingDetails') IS NULL OR ?=1)
  AND (options='' OR json_extract(NULLIF(options, ''), '$.supplierOrders') IS NULL OR ?=1)`;

const highlightsRequested = (query: string, options?: StockOptions | null): boolean =>
  !!query && options?.inventory === true && options.searchMode === "text";

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
      expires_at INTEGER NOT NULL, lease_id TEXT, lease_until INTEGER, result_json TEXT, query TEXT NOT NULL DEFAULT '',
      sort_field TEXT NOT NULL DEFAULT 'id', sort_direction TEXT NOT NULL DEFAULT 'asc'
    ) STRICT;
    CREATE INDEX IF NOT EXISTS nomenclature_stock_pending_idx ON nomenclature_stock_requests(created_at,id)
      WHERE status IN ('pending','leased');
    CREATE INDEX IF NOT EXISTS nomenclature_stock_expiry_idx ON nomenclature_stock_requests(expires_at);`);
    database.exec("BEGIN IMMEDIATE");
    try {
      const columns = new Set(database.prepare("PRAGMA table_info(nomenclature_stock_requests)").all().map((column) => column.name));
      if (!columns.has("query")) {
        database.exec("ALTER TABLE nomenclature_stock_requests ADD COLUMN query TEXT NOT NULL DEFAULT ''");
      }
      if (!columns.has("sort_field")) database.exec("ALTER TABLE nomenclature_stock_requests ADD COLUMN sort_field TEXT NOT NULL DEFAULT 'id'");
      if (!columns.has("sort_direction")) database.exec("ALTER TABLE nomenclature_stock_requests ADD COLUMN sort_direction TEXT NOT NULL DEFAULT 'asc'");
      if (!columns.has("options")) database.exec("ALTER TABLE nomenclature_stock_requests ADD COLUMN options TEXT NOT NULL DEFAULT ''");
      database.exec(`DROP INDEX IF EXISTS nomenclature_stock_active_idx;
        DROP INDEX IF EXISTS nomenclature_stock_search_active_idx;
        DROP INDEX IF EXISTS nomenclature_stock_sort_active_idx;
        CREATE UNIQUE INDEX IF NOT EXISTS nomenclature_stock_options_active_idx ON nomenclature_stock_requests(cursor,query,sort_field,sort_direction,options)
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

  async load(cursor: string | null, signal: AbortSignal, notifyWorker: () => void, query = "", sort: StockSort = defaultStockSort, options?: StockOptions, checkWorker?: () => void): Promise<StockPage> {
    if (signal.aborted) throw signal.reason;
    if (this.closed) throw new NomenclatureError(503, "stopping", "Соединение закрывается.");
    if (this.count >= 100) throw new NomenclatureError(429, "stock_busy", "Слишком много запросов остатков. Повторите позже.");
    const key = stockOptionsKey(options);
    decodeStockCursor(cursor, query, sort, key);
    this.cleanup();
    let row = this.database.prepare("SELECT * FROM nomenclature_stock_requests WHERE cursor=? AND query=? AND sort_field=? AND sort_direction=? AND options=? AND status IN ('pending','leased')").get(cursor ?? "", query, sort.field, sort.direction, key) as unknown as Row | undefined;
    if (!row) {
      const active = this.database.prepare("SELECT COUNT(*) AS count FROM nomenclature_stock_requests WHERE status IN ('pending','leased')").get()!.count;
      if (Number(active) >= 20) throw new NomenclatureError(429, "stock_busy", "Очередь остатков занята. Повторите позже.");
      const id = randomUUID();
      this.database.prepare("INSERT INTO nomenclature_stock_requests (id,cursor,status,created_at,expires_at,query,sort_field,sort_direction,options) VALUES (?,?,'pending',?,?,?,?,?,?)")
        .run(id, cursor ?? "", this.now(), this.now() + ttl, query, sort.field, sort.direction, key);
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
          try { checkWorker?.(); } catch (error) { return finish(error); }
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
  claim(version: number) {
    this.cleanup();
    const now = this.now();
    const row = this.database.prepare(`UPDATE nomenclature_stock_requests SET status='leased',lease_id=?,lease_until=? WHERE id=(
      SELECT id FROM nomenclature_stock_requests WHERE expires_at>? AND (status='pending' OR status='leased' AND lease_until<=?)
      ${stockWorkerConditions}
      ORDER BY created_at,id LIMIT 1) RETURNING *`).get(randomUUID(), now + 10_000, now, now, ...stockWorkerFlags(version)) as unknown as Row | undefined;
    const options = row?.options ? JSON.parse(row.options) as StockOptions : null;
    return row ? { kind: "stock" as const, id: row.id, leaseId: row.lease_id!,
      after: version >= 4 ? decodeStockCursor(row.cursor || null, row.query, { field: row.sort_field, direction: row.sort_direction }, row.options) : row.cursor || null,
      ...(version >= 2 ? { query: row.query } : {}),
      ...(version >= 4 ? { sortField: row.sort_field, sortDirection: row.sort_direction } : {}),
      ...(version >= 5 ? { options: highlightsRequested(row.query, options) ? { ...options, highlightSynonyms: true } : options } : {}),
      limit: stockPageSize, expiresAt: new Date(row.expires_at).toISOString() } : null;
  }
  complete(data: StockResult): void {
    const row = this.database.prepare("SELECT * FROM nomenclature_stock_requests WHERE id=?").get(data.requestId) as unknown as Row | undefined;
    if (!row || row.lease_id !== data.leaseId) throw new NomenclatureError(409, "lease_mismatch", "Аренда запроса остатков изменилась.");
    const sort: StockSort = { field: row.sort_field, direction: row.sort_direction };
    const after = decodeStockCursor(row.cursor || null, row.query, sort, row.options);
    const options = row.options ? JSON.parse(row.options) as StockOptions : undefined;
    if (data.status === "completed" && row.sort_field === "price" && !options?.priceType) {
      throw new NomenclatureError(400, "invalid_stock", "Для сортировки по цене выберите вид цены.");
    }
    const purchasing = options?.supplierOrders;
    const supplierOrders = data.supplierOrders;
    if (purchasing || supplierOrders) {
      const pageAfter = purchasing?.view === "list" ? purchasing.after : null;
      if (!purchasing || data.products.length || data.hasMore || data.lastSortValue != null || data.totalCount !== undefined
        || data.priceTypes !== undefined || data.navigation !== undefined || data.incomingDetails !== undefined
        || (data.status === "completed") !== (supplierOrders !== undefined)
        || supplierOrders && (supplierOrders.view !== purchasing.view
          || supplierOrders.view !== "list" && purchasing.view !== "list" && supplierOrders.id !== purchasing.id
          || supplierOrders.view === "list" && pageAfter
            && supplierOrders.orders.some((order) => order.date > pageAfter.date || order.id === pageAfter.id))) {
        throw new NomenclatureError(400, "invalid_supplier_orders", "Ответ не соответствует запросу заказов поставщикам.");
      }
    } else if (options?.incomingDetails) {
      const incoming = options.incomingDetails;
      if (data.products.length || data.hasMore || data.lastSortValue != null || data.totalCount !== undefined
        || data.priceTypes !== undefined || data.navigation !== undefined
        || (data.status === "completed") !== (data.incomingDetails !== undefined)
        || data.incomingDetails?.orders.some((order) =>
          (order.productId === incoming.productId) !== (incoming.side === "original")
          || order.orderId === incoming.after?.orderId && order.productId === incoming.after?.productId)) {
        throw new NomenclatureError(400, "invalid_incoming", "Ответ не соответствует запросу поставок.");
      }
    } else if (data.incomingDetails !== undefined || data.status === "completed" && ((!!options?.navigation && !after) !== (data.navigation !== undefined)
      || data.products.some((item) =>
      ((options?.availability ?? "available") === "available" && item.quantity <= 0)
      || (options?.availability === "absent" && item.quantity > 0)
      || (options?.inventory ? item.incoming === undefined || item.quantity < 0 : item.incoming !== undefined)
      || (options?.priceType ? item.price === undefined : item.price !== undefined)
      || (item.nameMatches !== undefined && !highlightsRequested(row.query, options)))
      || options && !after && (data.totalCount === undefined || data.priceTypes === undefined
        || (data.hasMore ? data.totalCount <= data.products.length : data.totalCount !== data.products.length))
      || options && after && (data.totalCount !== undefined || data.priceTypes !== undefined))) {
      throw new NomenclatureError(400, "invalid_stock", "Ответ не соответствует отбору номенклатуры.");
    }
    const lastValue = row.sort_field === "id" ? null : data.hasMore ? validateStockSortValue(data.lastSortValue, row.sort_field, !!options) : null;
    const page: StockPage = { products: data.products, hasMore: data.hasMore,
      nextCursor: data.hasMore ? encodeStockCursor({ id: data.products.at(-1)!.id, value: lastValue }, row.query, sort, row.options) : null, receivedAt: new Date(this.now()).toISOString(),
      ...(data.navigation === undefined ? {} : { navigation: data.navigation }),
      ...(data.incomingDetails === undefined ? {} : { incomingDetails: data.incomingDetails }),
      ...(supplierOrders === undefined ? {} : { supplierOrders }),
      ...(data.totalCount === undefined ? {} : { totalCount: data.totalCount }), ...(data.priceTypes === undefined ? {} : { priceTypes: data.priceTypes }) };
    // Keep the timestamp of an accepted result when an identical delivery is retried.
    if (row?.result_json) page.receivedAt = (JSON.parse(row.result_json) as StockPage).receivedAt;
    const result = JSON.stringify(page);
    if (row.status === data.status && row.result_json === result) return;
    if (row.status !== "leased" || row.expires_at <= this.now() || data.products.some((product) => product.id === after?.id)) {
      throw new NomenclatureError(409, "stock_finished", "Запрос остатков завершён или истёк.");
    }
    this.database.prepare("UPDATE nomenclature_stock_requests SET status=?,result_json=? WHERE id=?").run(data.status, result, row.id);
    // Deliver the prepared page directly to its readers: no repeated SELECT/JSON.parse per reader.
    this.changes.emit("change", row.id, data.status === "completed" ? page : undefined);
  }
}

export const stockWorkerFlags = (version: number): number[] => [2, 3, 4, 5, 6, 7, 8, 9].map((minimum) => Number(version >= minimum));
