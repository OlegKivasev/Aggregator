import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { DatabaseSync } from "node:sqlite";
import { parseRepairCard, type RepairCard } from "./repair-card.ts";

export const refreshFailure = "Произошёл сбой обновления заказ-нарядов. Достоверность данных не подтверждена. Обратитесь в магазин.";
export class RepairRefreshError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message = refreshFailure) { super(message); this.statusCode = statusCode; }
}
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const validId = (value: unknown): value is string => typeof value === "string" && uuid.test(value) && value !== "00000000-0000-0000-0000-000000000000";
export const repairOwnerMatches = (card: RepairCard, fio?: string) => fio === undefined
  || card.responsibleFio?.replace(/\s+/g, " ").trim().toLocaleLowerCase("ru-RU") === fio;
interface Job {
  id: string; owner_id: string; test_platform: number; ids_json: string; versions_json: string;
  status: string; expires_at: number; lease_id: string | null; lease_until: number | null; result_json: string | null;
}
interface Result { repairs: RepairCard[]; removedDocumentIds: string[] }

// Uses the repository's connection so an entire reply and all its cards commit atomically.
export class RepairRefreshService {
  private readonly changes = new EventEmitter();
  private polls = 0;
  private closed = false;
  private readonly db: DatabaseSync;
  private readonly list: () => RepairCard[];
  private readonly version: (id: string, test: boolean) => string;
  private readonly apply: (result: Result, test: boolean) => void;
  private readonly now: () => number;
  constructor(db: DatabaseSync, list: () => RepairCard[], version: (id: string, test: boolean) => string,
    apply: (result: Result, test: boolean) => void, now: () => number = Date.now) {
    this.db = db; this.list = list; this.version = version; this.apply = apply; this.now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS repair_refresh_sources (test_platform INTEGER PRIMARY KEY, last_seen INTEGER) STRICT;
      CREATE TABLE IF NOT EXISTS repair_refresh_requests (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, test_platform INTEGER NOT NULL,
        ids_json TEXT NOT NULL, versions_json TEXT NOT NULL, status TEXT NOT NULL,
        expires_at INTEGER NOT NULL, lease_id TEXT, lease_until INTEGER, result_json TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS repair_refresh_pending ON repair_refresh_requests(test_platform, status, expires_at);`);
    db.exec(`CREATE TABLE IF NOT EXISTS repair_refresh_unverified (
      document_id TEXT NOT NULL, test_platform INTEGER NOT NULL, PRIMARY KEY(document_id, test_platform)
    ) STRICT;`);
  }
  private clean() {
    this.db.prepare("UPDATE repair_refresh_requests SET status='expired' WHERE status IN ('pending','leased') AND expires_at<=?").run(this.now());
    this.db.prepare("DELETE FROM repair_refresh_requests WHERE expires_at<?").run(this.now() - 86_400_000);
  }
  create(value: unknown, test: boolean, owner: string, fio?: string) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1
      || !("documentIds" in value) || !Array.isArray(value.documentIds) || !value.documentIds.length
      || value.documentIds.length > 200 || value.documentIds.some((id: unknown) => !validId(id))) {
      throw new RepairRefreshError(400, "Для обновления выберите от 1 до 200 показанных заказ-нарядов.");
    }
    const ids: string[] = value.documentIds.map((id: string) => id.toLowerCase());
    if (new Set(ids).size !== ids.length) throw new RepairRefreshError(400);
    this.clean();
    const allowed = new Set(this.list().filter((card) => (card.testPlatform === true) === test && repairOwnerMatches(card, fio)).map((card) => card.documentId));
    if (ids.some((id) => !allowed.has(id))) throw new RepairRefreshError(404);
    // Persist uncertainty so reloading the page cannot turn old counters into verified values.
    const invalidate = this.db.prepare("INSERT OR IGNORE INTO repair_refresh_unverified VALUES (?,?)");
    for (const id of ids) invalidate.run(id, Number(test));
    const lastSeen = this.db.prepare("SELECT last_seen FROM repair_refresh_sources WHERE test_platform=?").get(Number(test))?.last_seen;
    if (typeof lastSeen !== "number" || this.now() - lastSeen >= 45_000) throw new RepairRefreshError(503);
    const count = Number(this.db.prepare("SELECT count(*) AS count FROM repair_refresh_requests WHERE status IN ('pending','leased') AND owner_id=?").get(owner)!.count);
    const total = Number(this.db.prepare("SELECT count(*) AS count FROM repair_refresh_requests WHERE status IN ('pending','leased')").get()!.count);
    if (count || total >= 50) throw new RepairRefreshError(429, "Обновление уже выполняется. Дождитесь результата.");
    const id = randomUUID();
    const versions = ids.map((id) => this.version(id, test));
    this.db.prepare("INSERT INTO repair_refresh_requests VALUES (?,?,?,?,?,'pending',?,NULL,NULL,NULL)")
      .run(id, owner, Number(test), JSON.stringify(ids), JSON.stringify(versions), this.now() + 60_000);
    this.changes.emit("change");
    return this.get(id, test, owner, fio);
  }
  get(id: string, test: boolean, owner: string, fio?: string) {
    this.clean();
    const job = this.db.prepare("SELECT * FROM repair_refresh_requests WHERE id=? AND test_platform=? AND owner_id=?")
      .get(id, Number(test), owner) as unknown as Job | undefined;
    if (!job) throw new RepairRefreshError(404);
    let result: Result | undefined;
    if (job.status === "completed") {
      const ids = JSON.parse(job.ids_json) as string[], versions = JSON.parse(job.versions_json) as string[];
      if (ids.some((id, index) => this.version(id, test) !== versions[index])) {
        this.db.prepare("UPDATE repair_refresh_requests SET status='error', result_json=NULL WHERE id=?").run(id);
        const invalidate = this.db.prepare("INSERT OR IGNORE INTO repair_refresh_unverified VALUES (?,?)");
        for (const documentId of ids) invalidate.run(documentId, Number(test));
        return { id: job.id, status: "error", expiresAt: new Date(job.expires_at).toISOString(), message: refreshFailure };
      }
      const stored = JSON.parse(job.result_json!) as Result;
      const current = new Set(this.list().filter((card) => (card.testPlatform === true) === test && repairOwnerMatches(card, fio)).map((card) => card.documentId));
      // An order may have changed its responsible employee while 1C was reading it.
      const hidden = stored.repairs.filter((card) => !repairOwnerMatches(card, fio) || !current.has(card.documentId)).map((card) => card.documentId);
      result = { repairs: stored.repairs.filter((card) => repairOwnerMatches(card, fio) && current.has(card.documentId)), removedDocumentIds: [...stored.removedDocumentIds, ...hidden] };
    }
    return { id: job.id, status: job.status === "leased" ? "pending" : job.status,
      expiresAt: new Date(job.expires_at).toISOString(), ...(result ?? {}),
      ...(["error", "expired", "cancelled"].includes(job.status) ? { message: refreshFailure } : {}) };
  }
  cancel(id: string, test: boolean, owner: string) {
    this.get(id, test, owner);
    this.db.prepare("UPDATE repair_refresh_requests SET status='cancelled' WHERE id=? AND status IN ('pending','leased')").run(id);
  }
  claim(test: boolean) {
    this.clean();
    this.db.prepare("INSERT INTO repair_refresh_sources VALUES (?,?) ON CONFLICT(test_platform) DO UPDATE SET last_seen=excluded.last_seen")
      .run(Number(test), this.now());
    const lease = randomUUID();
    const row = this.db.prepare(`UPDATE repair_refresh_requests SET status='leased', lease_id=?, lease_until=?
      WHERE id=(SELECT id FROM repair_refresh_requests WHERE test_platform=? AND expires_at>?
        AND (status='pending' OR (status='leased' AND lease_until<=?)) ORDER BY expires_at LIMIT 1) RETURNING *`)
      .get(lease, this.now() + 45_000, Number(test), this.now(), this.now()) as unknown as Job | undefined;
    return row ? { id: row.id, leaseId: lease, documentIds: JSON.parse(row.ids_json) as string[], testPlatform: test,
      expiresAt: new Date(row.expires_at).toISOString() } : null;
  }
  complete(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new RepairRefreshError(400);
    const data = value as Record<string, unknown>;
    if (!validId(data.requestId) || !validId(data.leaseId) || typeof data.testPlatform !== "boolean") throw new RepairRefreshError(400);
    this.clean();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.db.prepare("SELECT * FROM repair_refresh_requests WHERE id=? AND test_platform=?")
        .get(data.requestId, Number(data.testPlatform)) as unknown as Job | undefined;
      if (!job || job.lease_id !== data.leaseId) throw new RepairRefreshError(409);
      if (job.status === "completed" && data.status === "success" && Array.isArray(data.repairs) && Array.isArray(data.removedDocumentIds)
        && Object.keys(data).every((key) => ["requestId", "leaseId", "testPlatform", "status", "repairs", "removedDocumentIds"].includes(key))
        && JSON.stringify({ repairs: data.repairs.map(parseRepairCard), removedDocumentIds: data.removedDocumentIds }) === job.result_json) {
        this.db.exec("COMMIT");
        return { accepted: true, requestId: job.id, status: "completed" };
      }
      if (job.status !== "leased" || job.lease_until! <= this.now()) throw new RepairRefreshError(409);
      let result: Result | undefined;
      try {
        if (Object.keys(data).some((key) => !["requestId", "leaseId", "testPlatform", "status", "repairs", "removedDocumentIds"].includes(key))
          || data.status !== "success" || !Array.isArray(data.repairs) || !Array.isArray(data.removedDocumentIds)) throw new Error("Invalid reply");
        const ids = JSON.parse(job.ids_json) as string[];
        if (data.repairs.length + data.removedDocumentIds.length !== ids.length) throw new Error("Incomplete reply");
        const repairs = data.repairs.map(parseRepairCard);
        if (repairs.some((card) => !card.goodsReadiness || card.status !== "В работе" || (card.testPlatform === true) !== data.testPlatform)
          || data.removedDocumentIds.some((id) => !validId(id))) throw new Error("Invalid cards");
        const removedDocumentIds = data.removedDocumentIds.map((id) => (id as string).toLowerCase());
        const covered = [...repairs.map((card) => card.documentId), ...removedDocumentIds];
        if (new Set(covered).size !== ids.length || covered.some((id) => !ids.includes(id))) throw new Error("Unexpected cards");
        const versions = JSON.parse(job.versions_json) as string[];
        const changedIds = ids.filter((id, index) => this.version(id, data.testPlatform as boolean) !== versions[index]);
        if (changedIds.length) {
          const current = new Map(this.list().filter((card) => (card.testPlatform === true) === data.testPlatform)
            .map((card) => [card.documentId, JSON.stringify(parseRepairCard(card))]));
          const incoming = new Map(repairs.map((card) => [card.documentId, JSON.stringify(card)]));
          // The independent scheduled sender may have delivered this exact 1C snapshot
          // first. Confirm matching values/removals, but never overwrite a different update.
          if (changedIds.some((id) => current.get(id) !== incoming.get(id))) throw new Error("Concurrent update");
        }
        result = { repairs, removedDocumentIds };
      } catch { /* A partial or malformed result invalidates the whole requested batch. */ }
      if (result) {
        this.apply(result, data.testPlatform);
        const verified = this.db.prepare("DELETE FROM repair_refresh_unverified WHERE document_id=? AND test_platform=?");
        for (const id of JSON.parse(job.ids_json) as string[]) verified.run(id, Number(data.testPlatform));
      }
      const versions = (JSON.parse(job.ids_json) as string[]).map((id) => this.version(id, data.testPlatform as boolean));
      this.db.prepare("UPDATE repair_refresh_requests SET status=?, result_json=?, versions_json=? WHERE id=?")
        .run(result ? "completed" : "error", result ? JSON.stringify(result) : null, JSON.stringify(versions), job.id);
      this.db.exec("COMMIT");
      this.changes.emit("change");
      return { accepted: true, requestId: job.id, status: result ? "completed" : "error" };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  beginPoll() {
    if (this.polls >= 4) throw new RepairRefreshError(429);
    this.polls += 1;
    return () => { this.polls -= 1; };
  }
  unverified(ids: string[], test: boolean): string[] {
    const allowed = new Set(ids);
    return this.db.prepare("SELECT document_id FROM repair_refresh_unverified WHERE test_platform=?").all(Number(test))
      .map((row) => row.document_id as string).filter((id) => allowed.has(id));
  }
  async wait(signal: AbortSignal, duration: number) {
    if (signal.aborted || this.closed) return;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); this.changes.removeListener("change", done); resolve(); };
      const timer = setTimeout(done, Math.min(duration, 1000));
      signal.addEventListener("abort", done, { once: true }); this.changes.once("change", done);
    });
  }
  close() { this.closed = true; this.changes.emit("change"); }
}
