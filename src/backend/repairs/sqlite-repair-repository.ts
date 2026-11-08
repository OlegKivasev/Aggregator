import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { GoodsReadiness, RepairCard } from "./repair-card.ts";

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
          vehicle_name TEXT NOT NULL, status TEXT NOT NULL, responsible_fio TEXT, counterparty_name TEXT, goods_total_positions INTEGER, goods_available_positions INTEGER
        ) STRICT;
        CREATE TABLE IF NOT EXISTS test_repair_cards (
          document_id TEXT PRIMARY KEY NOT NULL,
          number TEXT NOT NULL, date TEXT NOT NULL,
          vehicle_name TEXT NOT NULL, status TEXT NOT NULL, responsible_fio TEXT, counterparty_name TEXT, goods_total_positions INTEGER, goods_available_positions INTEGER
        ) STRICT;
      `);
      // Existing installations retain both repair tables and every stored card.
      this.database.exec("BEGIN IMMEDIATE");
      try {
        for (const table of ["repair_cards", "test_repair_cards"]) {
          const columns = this.database.prepare(`PRAGMA table_info(${table})`).all();
          if (!columns.some((column) => column.name === "counterparty_name")) {
            this.database.exec(`ALTER TABLE ${table} ADD COLUMN counterparty_name TEXT`);
          }
          if (!columns.some((column) => column.name === "responsible_fio")) {
            this.database.exec(`ALTER TABLE ${table} ADD COLUMN responsible_fio TEXT`);
          }
          for (const name of ["goods_total_positions", "goods_available_positions"]) {
            if (!columns.some((column) => column.name === name)) {
              this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} INTEGER`);
            }
          }
          const previousTotal = columns.some((column) => column.name === "total_positions");
          const previousAvailable = columns.some((column) => column.name === "available_positions");
          if (previousTotal !== previousAvailable) throw new Error("Incomplete previous repair readiness schema");
          if (previousTotal) {
            // Recover counters written by the regressed schema, preserving untouched original values.
            // Remove duplicate columns so a later restart cannot overwrite newly updated readiness.
            this.database.exec(`
              UPDATE ${table} SET goods_total_positions = total_positions, goods_available_positions = available_positions
              WHERE total_positions IS NOT NULL OR available_positions IS NOT NULL;
              ALTER TABLE ${table} DROP COLUMN total_positions;
              ALTER TABLE ${table} DROP COLUMN available_positions;
            `);
          }
        }
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
      this.saveStatement = this.database.prepare(`
        INSERT INTO repair_cards (document_id, number, date, vehicle_name, status, responsible_fio, counterparty_name, goods_total_positions, goods_available_positions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(document_id) DO UPDATE SET
          number = excluded.number, date = excluded.date,
          vehicle_name = excluded.vehicle_name, status = excluded.status, responsible_fio = excluded.responsible_fio, counterparty_name = excluded.counterparty_name,
          goods_total_positions = excluded.goods_total_positions, goods_available_positions = excluded.goods_available_positions
      `);
      this.testSaveStatement = this.database.prepare(`
        INSERT INTO test_repair_cards (document_id, number, date, vehicle_name, status, responsible_fio, counterparty_name, goods_total_positions, goods_available_positions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(document_id) DO UPDATE SET
          number = excluded.number, date = excluded.date,
          vehicle_name = excluded.vehicle_name, status = excluded.status, responsible_fio = excluded.responsible_fio, counterparty_name = excluded.counterparty_name,
          goods_total_positions = excluded.goods_total_positions, goods_available_positions = excluded.goods_available_positions
      `);
      this.listStatement = this.database.prepare(`
        SELECT document_id AS documentId, number, date, vehicle_name AS vehicleName, status, responsible_fio AS responsibleFio, counterparty_name AS counterpartyName, goods_total_positions AS goodsTotalPositions, goods_available_positions AS goodsAvailablePositions, 0 AS testPlatform
        FROM repair_cards WHERE status = 'В работе'
        UNION ALL
        SELECT document_id AS documentId, number, date, vehicle_name AS vehicleName, status, responsible_fio AS responsibleFio, counterparty_name AS counterpartyName, goods_total_positions AS goodsTotalPositions, goods_available_positions AS goodsAvailablePositions, 1 AS testPlatform
        FROM test_repair_cards WHERE status = 'В работе'
        ORDER BY date DESC, documentId ASC, testPlatform ASC
      `);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  save(card: RepairCard): void {
    const statement = card.testPlatform === true ? this.testSaveStatement : this.saveStatement;
    statement.run(card.documentId, card.number, card.date, card.vehicleName, card.status, card.responsibleFio ?? null, card.counterpartyName ?? null, card.goodsReadiness?.totalPositions ?? null, card.goodsReadiness?.availablePositions ?? null);
  }

  list(): RepairCard[] {
    return this.listStatement.all().map((row) => {
      const { documentId, number, date, vehicleName, status, responsibleFio, counterpartyName } = row;
      if (typeof documentId !== "string" || typeof number !== "string" || typeof date !== "string"
        || typeof vehicleName !== "string" || typeof status !== "string") {
        throw new Error("Invalid SQLite repair card");
      }
      if (row.testPlatform !== 0 && row.testPlatform !== 1) throw new Error("Invalid SQLite repair platform");
      if (counterpartyName !== null && typeof counterpartyName !== "string") throw new Error("Invalid SQLite repair counterparty");
      if (responsibleFio !== null && typeof responsibleFio !== "string") throw new Error("Invalid SQLite repair responsible FIO");
      const total = row.goodsTotalPositions;
      const available = row.goodsAvailablePositions;
      let goodsReadiness: GoodsReadiness | undefined;
      if (total !== null || available !== null) {
        if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0 || total > 100_000
          || typeof available !== "number" || !Number.isSafeInteger(available) || available < 0 || available > total) {
          throw new Error("Invalid SQLite goods readiness");
        }
        goodsReadiness = { totalPositions: total, availablePositions: available };
      }
      return { documentId, number, date, vehicleName, status,
        ...(responsibleFio !== null ? { responsibleFio } : {}),
        ...(row.testPlatform === 1 ? { testPlatform: true } : {}),
        ...(counterpartyName !== null ? { counterpartyName } : {}),
        ...(goodsReadiness !== undefined ? { goodsReadiness } : {}),
      };
    });
  }

  counts(): { production: number; test: number } {
    const row = this.database.prepare(`SELECT
      (SELECT count(*) FROM repair_cards) AS production,
      (SELECT count(*) FROM test_repair_cards) AS test`).get();
    if (!row || typeof row.production !== "number" || !Number.isSafeInteger(row.production) || row.production < 0
      || typeof row.test !== "number" || !Number.isSafeInteger(row.test) || row.test < 0) {
      throw new Error("Invalid SQLite repair counts");
    }
    return { production: row.production, test: row.test };
  }

  remove(documentId: string, testPlatform: boolean): number {
    const table = testPlatform ? "test_repair_cards" : "repair_cards";
    return Number(this.database.prepare(`DELETE FROM ${table} WHERE document_id = ?`).run(documentId).changes);
  }

  clearProductionCards(): number {
    return Number(this.database.prepare("DELETE FROM repair_cards").run().changes);
  }

  clearTestCards(): number {
    return Number(this.database.prepare("DELETE FROM test_repair_cards").run().changes);
  }

  close(): void {
    this.database.close();
  }
}
