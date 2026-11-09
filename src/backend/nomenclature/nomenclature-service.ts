import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NomenclatureError, type LookupResult } from "./contract.ts";

interface SourceRow { id: string; token_hash: string | null; last_seen: number | null }
interface LookupRow {
  id: string; source_id: string; owner_id: string; barcode: string;
  status: string; created_at: number; expires_at: number; lease_id: string | null; lease_until: number | null; result_json: string | null;
}
const hash = (value: string) => createHash("sha256").update(value).digest();
const ttlMs = 30_000;
const onlineMs = 45_000;
const source = "nomenclature";

export class NomenclatureService {
  private readonly database: DatabaseSync;
  private readonly changes = new EventEmitter();
  private pollCount = 0;
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
        CREATE TABLE IF NOT EXISTS nomenclature_lookups (
          id TEXT PRIMARY KEY, source_id TEXT NOT NULL, owner_id TEXT NOT NULL, barcode TEXT NOT NULL,
          status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
          lease_id TEXT, lease_until INTEGER, result_json TEXT
        ) STRICT;
        CREATE INDEX IF NOT EXISTS nomenclature_pending_idx ON nomenclature_lookups(source_id, status, created_at);
        CREATE INDEX IF NOT EXISTS nomenclature_owner_idx ON nomenclature_lookups(owner_id, status);
      `);
      this.migrateConnection();
    } catch (error) { this.database.close(); throw error; }
  }

  private migrateConnection(): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.database.prepare("SELECT id FROM nomenclature_sources WHERE id=?").get(source)) {
        // Preserve the previously selected key, or the only configured key.
        const hadSettings = this.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='nomenclature_settings'").get();
        const selected = hadSettings ? this.database.prepare("SELECT default_source FROM nomenclature_settings WHERE id=1").get()?.default_source : null;
        const previous = this.database.prepare(`SELECT * FROM nomenclature_sources
          WHERE token_hash IS NOT NULL ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END, id LIMIT 1`).get(selected ?? "production") as unknown as SourceRow | undefined;
        this.database.prepare("INSERT INTO nomenclature_sources VALUES (?,?,?)")
          .run(source, previous?.token_hash ?? null, null);
        this.database.prepare("UPDATE nomenclature_lookups SET status='error', result_json=? WHERE status IN ('pending','leased')")
          .run(JSON.stringify({ status: "error", products: [] }));
        this.database.prepare("UPDATE nomenclature_lookups SET source_id=?").run(source);
      }
      this.database.prepare("DELETE FROM nomenclature_sources WHERE id<>?").run(source);
      this.database.exec("DROP TABLE IF EXISTS nomenclature_settings; COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  close(): void {
    this.closed = true;
    this.changes.emit(source);
    this.database.close();
  }

  state() {
    const row = this.database.prepare("SELECT * FROM nomenclature_sources WHERE id=?").get(source) as unknown as SourceRow;
    return { configured: row.token_hash !== null,
      online: row.token_hash !== null && row.last_seen !== null && this.now() - row.last_seen < onlineMs,
      lastSeenAt: row.last_seen === null ? null : new Date(row.last_seen).toISOString() };
  }

  rotateKey(): string {
    const token = randomBytes(32).toString("base64url");
    this.changeKey(hash(token).toString("hex"));
    return token;
  }

  disconnect(): void { this.changeKey(null); }

  private changeKey(tokenHash: string | null): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("UPDATE nomenclature_sources SET token_hash=?, last_seen=NULL WHERE id=?").run(tokenHash, source);
      this.database.prepare("UPDATE nomenclature_lookups SET status='error', result_json=? WHERE source_id=? AND status IN ('pending','leased')")
        .run(JSON.stringify({ status: "error", products: [] }), source);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    this.changes.emit(source);
  }

  authenticate(token: string | undefined): void {
    if (this.closed) throw new NomenclatureError(503, "stopping", "Соединение закрывается.");
    const stored = this.database.prepare("SELECT token_hash FROM nomenclature_sources WHERE id=?").get(source)?.token_hash;
    const actual = hash(token ?? "");
    const expected = typeof stored === "string" ? Buffer.from(stored, "hex") : Buffer.alloc(32);
    if (!timingSafeEqual(actual, expected) || !token || token.length > 256 || !stored) {
      throw new NomenclatureError(401, "invalid_key", "Неверный ключ номенклатуры.");
    }
  }

  heartbeat(token: string | undefined): void {
    this.authenticate(token);
    this.database.prepare("UPDATE nomenclature_sources SET last_seen=? WHERE id=?").run(this.now(), source);
  }

  private cleanup(): void {
    this.database.prepare("UPDATE nomenclature_lookups SET status='expired' WHERE status IN ('pending','leased') AND expires_at<=?").run(this.now());
    this.database.prepare("DELETE FROM nomenclature_lookups WHERE expires_at<?").run(this.now() - 86_400_000);
  }

  create(barcode: string, owner: string) {
    this.cleanup();
    const connection = this.state();
    if (!connection.configured) throw new NomenclatureError(503, "source_unconfigured", "Подключение номенклатуры ещё не настроено.");
    if (!connection.online) throw new NomenclatureError(503, "source_offline", "Нет связи с 1С. Проверьте подключение и открытый сеанс 1С.");
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
    return { id: row.id, barcode: row.barcode,
      status: row.status === "leased" ? "pending" : row.status, createdAt: new Date(row.created_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(), products: result?.products ?? [] };
  }

  cancel(id: string, owner: string, isAdmin: boolean): void {
    this.get(id, owner, isAdmin);
    this.database.prepare("UPDATE nomenclature_lookups SET status='cancelled' WHERE id=? AND status IN ('pending','leased')").run(id);
  }

  claim(token: string | undefined) {
    this.heartbeat(token);
    this.cleanup();
    const now = this.now();
    const row = this.database.prepare(`UPDATE nomenclature_lookups SET status='leased', lease_id=?, lease_until=? WHERE id=(
      SELECT id FROM nomenclature_lookups WHERE source_id=? AND expires_at>? AND (status='pending' OR status='leased' AND lease_until<=?)
      ORDER BY created_at,id LIMIT 1) RETURNING *`).get(randomUUID(), now + 10_000, source, now, now) as unknown as LookupRow | undefined;
    return row ? { id: row.id, leaseId: row.lease_id!, barcode: row.barcode, expiresAt: new Date(row.expires_at).toISOString() } : null;
  }

  complete(token: string | undefined, data: LookupResult & { requestId: string; leaseId: string }): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.heartbeat(token);
      this.cleanup();
      const result = JSON.stringify({ status: data.status, products: data.products });
      const row = this.database.prepare("SELECT * FROM nomenclature_lookups WHERE id=? AND source_id=?").get(data.requestId, source) as unknown as LookupRow | undefined;
      if (!row || row.lease_id !== data.leaseId) throw new NomenclatureError(409, "lease_mismatch", "Запрос уже передан другому обработчику или не найден.");
      const duplicate = ["found", "not_found", "error"].includes(row.status) && row.result_json === result;
      if (!duplicate) {
        if (row.status !== "leased" || row.expires_at <= this.now()) throw new NomenclatureError(409, "request_finished", "Запрос уже завершён или истёк.");
        this.database.prepare("UPDATE nomenclature_lookups SET status=?, result_json=? WHERE id=?").run(data.status, result, data.requestId);
      }
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  beginPoll(): () => void {
    if (this.pollCount >= 2) throw new NomenclatureError(429, "poll_limit", "Обработчик номенклатуры уже подключён.");
    this.pollCount += 1;
    return () => { this.pollCount -= 1; };
  }

  async wait(signal: AbortSignal, milliseconds: number): Promise<void> {
    if (signal.aborted || this.closed) return;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); this.changes.removeListener(source, done); signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, Math.min(milliseconds, 1000));
      this.changes.once(source, done);
      signal.addEventListener("abort", done, { once: true });
    });
  }
}
