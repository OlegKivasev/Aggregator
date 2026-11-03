import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { RepairCard } from "./repair-card.ts";

export class SqliteRepairRepository {
  private readonly database: DatabaseSync;
  private readonly saveStatement: StatementSync;
  private readonly listStatement: StatementSync;

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
      `);
      this.saveStatement = this.database.prepare(`
        INSERT INTO repair_cards (document_id, number, date, vehicle_name, status) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(document_id) DO UPDATE SET
          number = excluded.number, date = excluded.date,
          vehicle_name = excluded.vehicle_name, status = excluded.status
      `);
      this.listStatement = this.database.prepare(`
        SELECT document_id AS documentId, number, date, vehicle_name AS vehicleName, status
        FROM repair_cards ORDER BY date DESC, document_id ASC
      `);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  save(card: RepairCard): void {
    this.saveStatement.run(card.documentId, card.number, card.date, card.vehicleName, card.status);
  }

  list(): RepairCard[] {
    return this.listStatement.all().map((row) => {
      const { documentId, number, date, vehicleName, status } = row;
      if (typeof documentId !== "string" || typeof number !== "string" || typeof date !== "string"
        || typeof vehicleName !== "string" || typeof status !== "string") {
        throw new Error("Invalid SQLite repair card");
      }
      return { documentId, number, date, vehicleName, status };
    });
  }

  close(): void {
    this.database.close();
  }
}
