import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { parseRepairCard, type RepairCard } from "./repair-card.ts";

export class SqliteRepairRepository {
  private readonly database: DatabaseSync;
  private readonly saveStatement: StatementSync;
  private readonly listStatement: StatementSync;
  private readonly testSaveStatement: StatementSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    try {
      this.database.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS repair_cards (
          document_id TEXT PRIMARY KEY NOT NULL,
          number TEXT NOT NULL, date TEXT NOT NULL,
          vehicle_name TEXT NOT NULL, status TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS test_repair_cards (
          document_id TEXT PRIMARY KEY NOT NULL,
          number TEXT NOT NULL, date TEXT NOT NULL,
          vehicle_name TEXT NOT NULL, status TEXT NOT NULL
        ) STRICT;
      `);
      this.database.exec("BEGIN IMMEDIATE");
      try {
        for (const table of ["repair_cards", "test_repair_cards"]) {
          const columns = new Set(this.database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
          for (const [name, type] of [["counterparty_name", "TEXT"], ["total_positions", "INTEGER"], ["available_positions", "INTEGER"]]) {
            if (!columns.has(name)) this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
          }
        }
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
      this.saveStatement = this.database.prepare(`
        INSERT INTO repair_cards (document_id, number, date, vehicle_name, status, counterparty_name, total_positions, available_positions)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(document_id) DO UPDATE SET
          number = excluded.number, date = excluded.date,
          vehicle_name = excluded.vehicle_name, status = excluded.status, counterparty_name = excluded.counterparty_name,
          total_positions = excluded.total_positions, available_positions = excluded.available_positions
      `);
      this.testSaveStatement = this.database.prepare(`
        INSERT INTO test_repair_cards (document_id, number, date, vehicle_name, status, counterparty_name, total_positions, available_positions)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(document_id) DO UPDATE SET
          number = excluded.number, date = excluded.date,
          vehicle_name = excluded.vehicle_name, status = excluded.status, counterparty_name = excluded.counterparty_name,
          total_positions = excluded.total_positions, available_positions = excluded.available_positions
      `);
      this.listStatement = this.database.prepare(`
        SELECT document_id AS documentId, number, date, vehicle_name AS vehicleName, status,
          counterparty_name AS counterpartyName, total_positions AS totalPositions, available_positions AS availablePositions,
          0 AS testPlatform FROM repair_cards
        UNION ALL
        SELECT document_id AS documentId, number, date, vehicle_name AS vehicleName, status,
          counterparty_name AS counterpartyName, total_positions AS totalPositions, available_positions AS availablePositions,
          1 AS testPlatform FROM test_repair_cards
        ORDER BY date DESC, documentId ASC, testPlatform ASC
      `);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  save(card: RepairCard): void {
    const statement = card.testPlatform === true ? this.testSaveStatement : this.saveStatement;
    statement.run(card.documentId, card.number, card.date, card.vehicleName, card.status, card.counterpartyName ?? null,
      card.goodsReadiness?.totalPositions ?? null, card.goodsReadiness?.availablePositions ?? null);
  }

  list(): RepairCard[] {
    return this.listStatement.all().map((row) => {
      const { documentId, number, date, vehicleName, status } = row;
      if (typeof documentId !== "string" || typeof number !== "string" || typeof date !== "string"
        || typeof vehicleName !== "string" || typeof status !== "string") {
        throw new Error("Invalid SQLite repair card");
      }
      if (row.testPlatform !== 0 && row.testPlatform !== 1) throw new Error("Invalid SQLite repair platform");
      try {
        return parseRepairCard({ documentId, number, date, vehicleName, status,
          ...(row.testPlatform === 1 ? { testPlatform: true } : {}),
          ...(row.counterpartyName !== null ? { counterpartyName: row.counterpartyName } : {}),
          ...(row.totalPositions !== null || row.availablePositions !== null
            ? { goodsReadiness: { totalPositions: row.totalPositions, availablePositions: row.availablePositions } } : {}),
        });
      } catch (error) {
        throw new Error("Invalid SQLite repair card", { cause: error });
      }
    });
  }

  clearTestCards(): number {
    return Number(this.database.prepare("DELETE FROM test_repair_cards").run().changes);
  }

  clearProductionCards(): number {
    return Number(this.database.prepare("DELETE FROM repair_cards").run().changes);
  }

  deleteCard(documentId: string, testPlatform: boolean): number {
    const table = testPlatform ? "test_repair_cards" : "repair_cards";
    return Number(this.database.prepare(`DELETE FROM ${table} WHERE document_id = ?`).run(documentId).changes);
  }

  counts(): { production: number; test: number } {
    const row = this.database.prepare(`SELECT
      (SELECT COUNT(*) FROM repair_cards) AS production,
      (SELECT COUNT(*) FROM test_repair_cards) AS test`).get();
    if (!row || typeof row.production !== "number" || typeof row.test !== "number") {
      throw new Error("Invalid SQLite repair counts");
    }
    return { production: row.production, test: row.test };
  }

  close(): void {
    this.database.close();
  }
}
