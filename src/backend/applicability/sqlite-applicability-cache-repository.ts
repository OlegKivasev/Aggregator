import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ApplicabilityCacheRepository } from "./applicability-application-service.ts";
import type { ApplicabilitySearchRequest, ApplicabilityVehicle } from "./types.ts";
import { parseApplicabilityVehicles } from "./vehicle-records.ts";

type SqlRow = Record<string, string | number | bigint | Uint8Array | null>;

function text(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Invalid SQLite ${key}`);
  return value;
}

function cacheKey(query: ApplicabilitySearchRequest): [string, string] {
  return [query.sku.toLocaleUpperCase(), query.brand.toLocaleUpperCase()];
}

export class SqliteApplicabilityCacheRepository implements ApplicabilityCacheRepository {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS applicability_search_cache (
        sku TEXT NOT NULL,
        brand TEXT NOT NULL,
        results_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (sku, brand)
      ) STRICT;
    `);
  }

  get(query: ApplicabilitySearchRequest): ApplicabilityVehicle[] | null {
    const [sku, brand] = cacheKey(query);
    const row = this.database.prepare("SELECT results_json FROM applicability_search_cache WHERE sku = ? AND brand = ?")
      .get(sku, brand) as SqlRow | undefined;
    if (!row) return null;

    try {
      return parseApplicabilityVehicles(JSON.parse(text(row, "results_json")));
    } catch {
      // A damaged cache entry must not block a fresh PartsAPI lookup.
      this.database.prepare("DELETE FROM applicability_search_cache WHERE sku = ? AND brand = ?").run(sku, brand);
      return null;
    }
  }

  set(query: ApplicabilitySearchRequest, results: ApplicabilityVehicle[]): void {
    const [sku, brand] = cacheKey(query);
    this.database.prepare(`INSERT INTO applicability_search_cache (sku, brand, results_json, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(sku, brand) DO UPDATE SET results_json = excluded.results_json, created_at = excluded.created_at`)
      .run(sku, brand, JSON.stringify(results), new Date().toISOString());
  }

  close(): void { this.database.close(); }
}
