import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NomenclatureError, sourceNames, type LookupResult, type NomenclatureSource } from "./contract.ts";

interface SourceRow { id: NomenclatureSource; token_hash: string | null; last_seen: number | null }
interface LookupRow {
  id: string; source_id: NomenclatureSource; owner_id: string; barcode: string;
  status: string; created_at: number; expires_at: number; lease_id: string | null; lease_until: number | null; result_json: string | null;
}
const hash = (value: string) => createHash("sha256").update(value).digest();
const ttlMs = 30_000;
const onlineMs = 45_000;

export class NomenclatureService {
  private readonly database: DatabaseSync;
  private readonly changes = new EventEmitter();
  private readonly pollCounts = new Map<NomenclatureSource, number>();
  private closed = false;
  private readonly now: () => number;

  constructor(path: string, now: () => number = Date.now) {
    this.now = now;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    try {
      this.database.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS nomenclature_sources (
          id TEXT PRIMARY KEY, token_hash TEXT, last_seen INTEGER
        ) STRICT;
        INSERT OR IGNORE INTO nomenclature_sources VALUES ('production', NULL, NULL), ('test', NULL, NULL);
        CREATE TABLE IF NOT EXISTS nomenclature_settings (id INTEGER PRIMARY KEY CHECK(id=1), default_source TEXT NOT NULL) STRICT;
        INSERT OR IGNORE INTO nomenclature_settings VALUES (1, 'production');
        CREATE TABLE IF NOT EXISTS nomenclature_lookups (
          id TEXT PRIMARY KEY, source_id TEXT NOT NULL, owner_id TEXT NOT NULL, barcode TEXT NOT NULL,
          status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
          lease_id TEXT, lease_until INTEGER, result_json TEXT
        ) STRICT;
        CREATE INDEX IF NOT EXISTS nomenclature_pending_idx ON nomenclature_lookups(source_id, status, created_at);
        CREATE INDEX IF NOT EXISTS nomenclature_owner_idx ON nomenclature_lookups(owner_id, status);
      `);
    } catch (error) { this.database.close(); throw error; }
  }

  close(): void {
    this.closed = true;
    for (const source of Object.keys(sourceNames)) this.changes.emit(source);
    this.database.close();
  }

  state() {
    const rows = this.database.prepare("SELECT * FROM nomenclature_sources ORDER BY id").all() as unknown as SourceRow[];
    return {
      defaultSource: (this.database.prepare("SELECT default_source FROM nomenclature_settings WHERE id=1").get()!.default_source) as NomenclatureSource,
      sources: rows.map((row) => ({ id: row.id, name: sourceNames[row.id], configured: row.token_hash !== null,
        online: row.token_hash !== null && row.last_seen !== null && this.now() - row.last_seen < onlineMs,
        lastSeenAt: row.last_seen === null ? null : new Date(row.last_seen).toISOString() })),
    };
  }

  setDefault(source: NomenclatureSource): void {
    this.database.prepare("UPDATE nomenclature_settings SET default_source=? WHERE id=1").run(source);
  }

  rotateKey(source: NomenclatureSource): string {
    const token = randomBytes(32).toString("base64url");
    this.changeKey(source, hash(token).toString("hex"));
    return token;
  }

  disconnect(source: NomenclatureSource): void { this.changeKey(source, null); }

  private changeKey(source: NomenclatureSource, tokenHash: string | null): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("UPDATE nomenclature_sources SET token_hash=?, last_seen=NULL WHERE id=?").run(tokenHash, source);
      this.database.prepare("UPDATE nomenclature_lookups SET status='error', result_json=? WHERE source_id=? AND status IN ('pending','leased')")
        .run(JSON.stringify({ status: "error", products: [] }), source);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    this.changes.emit(source);
  }

  authenticate(source: NomenclatureSource, token: string | undefined): void {
    if (this.closed) throw new NomenclatureError(503, "stopping", "Соединение закрывается.");
    const stored = this.database.prepare("SELECT token_hash FROM nomenclature_sources WHERE id=?").get(source)?.token_hash;
    const actual = hash(token ?? "");
    const expected = typeof stored === "string" ? Buffer.from(stored, "hex") : Buffer.alloc(32);
    if (!timingSafeEqual(actual, expected) || !token || token.length > 256 || !stored) {
      throw new NomenclatureError(401, "invalid_key", "Неверный ключ подключения базы.");
    }
  }

  heartbeat(source: NomenclatureSource, token: string | undefined): void {
    this.authenticate(source, token);
    this.database.prepare("UPDATE nomenclature_sources SET last_seen=? WHERE id=?").run(this.now(), source);
  }

  private cleanup(): void {
    this.database.prepare("UPDATE nomenclature_lookups SET status='expired' WHERE status IN ('pending','leased') AND expires_at<=?").run(this.now());
    this.database.prepare("DELETE FROM nomenclature_lookups WHERE expires_at<?").run(this.now() - 86_400_000);
  }

  create(source: NomenclatureSource, barcode: string, owner: string) {
    this.cleanup();
    const connection = this.state().sources.find((row) => row.id === source)!;
    if (!connection.configured) throw new NomenclatureError(503, "source_unconfigured", "Подключение выбранной базы 1С ещё не настроено.");
    if (!connection.online) throw new NomenclatureError(503, "source_offline", "Нет связи с выбранной базой 1С. Проверьте обмен и открытый сеанс 1С.");
    const id = randomUUID();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const count = Number(this.database.prepare("SELECT COUNT(*) AS count FROM nomenclature_lookups WHERE status IN ('pending','leased') AND (owner_id=? OR source_id=?)").get(owner, source)!.count);
      if (count >= 100 || Number(this.database.prepare("SELECT COUNT(*) AS count FROM nomenclature_lookups WHERE owner_id=? AND status IN ('pending','leased')").get(owner)!.count) >= 3) {
        throw new NomenclatureError(429, "busy", "Дождитесь завершения предыдущего поиска.");
      }
      const now = this.now();
      this.database.prepare("INSERT INTO nomenclature_lookups VALUES (?,?,?,?, 'pending',?,?,NULL,NULL,NULL)").run(id, source, owner, barcode, now, now + ttlMs);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    this.changes.emit(source);
    return this.get(id, owner, false);
  }

  get(id: string, owner: string, isAdmin: boolean) {
    this.cleanup();
    const row = this.database.prepare("SELECT * FROM nomenclature_lookups WHERE id=?").get(id) as unknown as LookupRow | undefined;
    if (!row || row.owner_id !== owner && !isAdmin) throw new NomenclatureError(404, "not_found", "Запрос не найден.");
    const result = row.result_json ? JSON.parse(row.result_json) as LookupResult : null;
    return { id: row.id, sourceId: row.source_id, sourceName: sourceNames[row.source_id], barcode: row.barcode,
      status: row.status === "leased" ? "pending" : row.status, createdAt: new Date(row.created_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(), products: result?.products ?? [] };
  }

  cancel(id: string, owner: string, isAdmin: boolean): void {
    this.get(id, owner, isAdmin);
    this.database.prepare("UPDATE nomenclature_lookups SET status='cancelled' WHERE id=? AND status IN ('pending','leased')").run(id);
  }

  claim(source: NomenclatureSource, token: string | undefined) {
    this.heartbeat(source, token);
    this.cleanup();
    const now = this.now();
    const row = this.database.prepare(`UPDATE nomenclature_lookups SET status='leased', lease_id=?, lease_until=? WHERE id=(
      SELECT id FROM nomenclature_lookups WHERE source_id=? AND expires_at>? AND (status='pending' OR status='leased' AND lease_until<=?)
      ORDER BY created_at,id LIMIT 1) RETURNING *`).get(randomUUID(), now + 10_000, source, now, now) as unknown as LookupRow | undefined;
    return row ? { id: row.id, leaseId: row.lease_id!, barcode: row.barcode, expiresAt: new Date(row.expires_at).toISOString() } : null;
  }

  complete(source: NomenclatureSource, token: string | undefined, data: LookupResult & { requestId: string; leaseId: string }): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.heartbeat(source, token);
      this.cleanup();
      const result = JSON.stringify({ status: data.status, products: data.products });
      const row = this.database.prepare("SELECT * FROM nomenclature_lookups WHERE id=? AND source_id=?").get(data.requestId, source) as unknown as LookupRow | undefined;
      if (!row || row.lease_id !== data.leaseId) throw new NomenclatureError(409, "lease_mismatch", "Запрос уже передан другому обработчику или не принадлежит этой базе.");
      const duplicate = ["found", "not_found", "error"].includes(row.status) && row.result_json === result;
      if (!duplicate) {
        if (row.status !== "leased" || row.expires_at <= this.now()) throw new NomenclatureError(409, "request_finished", "Запрос уже завершён или истёк.");
        this.database.prepare("UPDATE nomenclature_lookups SET status=?, result_json=? WHERE id=?").run(data.status, result, data.requestId);
      }
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  beginPoll(source: NomenclatureSource): () => void {
    const count = this.pollCounts.get(source) ?? 0;
    if (count >= 2) throw new NomenclatureError(429, "poll_limit", "Обработчик этой базы уже подключён.");
    this.pollCounts.set(source, count + 1);
    return () => this.pollCounts.set(source, (this.pollCounts.get(source) ?? 1) - 1);
  }

  async wait(source: NomenclatureSource, signal: AbortSignal, milliseconds: number): Promise<void> {
    if (signal.aborted || this.closed) return;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); this.changes.removeListener(source, done); signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, Math.min(milliseconds, 1000));
      this.changes.once(source, done);
      signal.addEventListener("abort", done, { once: true });
    });
  }
}
