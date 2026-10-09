import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ApplicabilityCacheRepository } from "./applicability-application-service.ts";
import type { ApplicabilitySavedArticlesPage, ApplicabilitySavedArticlesQuery, ApplicabilitySearchRequest, ApplicabilityVehicle } from "./types.ts";
import { normalizeApplicabilitySku, parseApplicabilityVehicles } from "./vehicle-records.ts";

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

  findBrands(sku: string): string[] {
    const normalizedSku = normalizeApplicabilitySku(sku);
    if (!normalizedSku) return [];
    const rows = this.database.prepare("SELECT sku, brand FROM applicability_search_cache").all() as SqlRow[];
    return [...new Set(rows
      .filter((row) => typeof row.sku === "string" && normalizeApplicabilitySku(row.sku) === normalizedSku)
      .map((row) => text(row, "brand")))];
  }

  set(query: ApplicabilitySearchRequest, results: ApplicabilityVehicle[]): void {
    const [sku, brand] = cacheKey(query);
    this.database.prepare(`INSERT INTO applicability_search_cache (sku, brand, results_json, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(sku, brand) DO UPDATE SET results_json = excluded.results_json, created_at = excluded.created_at`)
      .run(sku, brand, JSON.stringify(results), new Date().toISOString());
  }

  list(query: ApplicabilitySavedArticlesQuery): ApplicabilitySavedArticlesPage {
    const search = query.search.toLocaleUpperCase();
    const order = query.order === "brand" ? "brand, sku" : "sku, brand";
    const rows = this.database.prepare(`SELECT sku, brand FROM applicability_search_cache
      WHERE (instr(sku, ?) > 0 OR instr(brand, ?) > 0)
        AND (? = 1 OR CASE WHEN json_valid(results_json) THEN json_array_length(results_json) > 0 ELSE 0 END)
      ORDER BY ${order} LIMIT 101 OFFSET ?`).all(search, search, query.includeNotFound ? 1 : 0, query.offset) as SqlRow[];
    return {
      articles: rows.slice(0, 100).map((row) => ({ sku: text(row, "sku"), brand: text(row, "brand") })),
      hasMore: rows.length > 100,
    };
  }

  delete(query: ApplicabilitySearchRequest): boolean {
    const [sku, brand] = cacheKey(query);
    return this.database.prepare("DELETE FROM applicability_search_cache WHERE sku = ? AND brand = ?")
      .run(sku, brand).changes > 0;
  }

  close(): void { this.database.close(); }
}
