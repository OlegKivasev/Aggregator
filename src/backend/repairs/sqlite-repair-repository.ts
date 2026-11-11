import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { parseRepairPaymentOptions, type GoodsReadiness, type RepairCard } from "./repair-card.ts";
import { RepairRefreshService } from "./repair-refresh-service.ts";

export class SqliteRepairRepository {
  readonly refreshes: RepairRefreshService;
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
          if (!columns.some((column) => column.name === "payment_status")) {
            this.database.exec(`ALTER TABLE ${table} ADD COLUMN payment_status TEXT CHECK (payment_status IN ('paid', 'payment_required', 'partially_paid'))`);
          } else {
            const schema = this.database.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table);
            if (typeof schema?.sql !== "string") throw new Error("Invalid SQLite repair schema");
            if (!schema.sql.includes("'partially_paid'")) {
              // SQLite cannot extend the old two-status CHECK in place. Replace only
              // this column, inside the migration transaction, preserving every row.
              this.database.exec(`
                ALTER TABLE ${table} ADD COLUMN payment_status_upgrade TEXT CHECK (payment_status_upgrade IN ('paid', 'payment_required', 'partially_paid'));
                UPDATE ${table} SET payment_status_upgrade = payment_status;
                ALTER TABLE ${table} DROP COLUMN payment_status;
                ALTER TABLE ${table} RENAME COLUMN payment_status_upgrade TO payment_status;
              `);
            }
          }
          if (!columns.some((column) => column.name === "amount_due_minor")) {
            this.database.exec(`ALTER TABLE ${table} ADD COLUMN amount_due_minor INTEGER CHECK (amount_due_minor >= 0)`);
          }
          for (const name of ["card_amount_due_minor", "cash_amount_due_minor", "cash_discount_hundredths"]) {
            if (!columns.some((column) => column.name === name)) {
              this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} INTEGER CHECK (${name} >= 0)`);
            }
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
        INSERT INTO repair_cards (document_id, number, date, vehicle_name, status, responsible_fio, counterparty_name, goods_total_positions, goods_available_positions, payment_status, amount_due_minor, card_amount_due_minor, cash_amount_due_minor, cash_discount_hundredths) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(document_id) DO UPDATE SET
          number = excluded.number, date = excluded.date,
          vehicle_name = excluded.vehicle_name, status = excluded.status, responsible_fio = excluded.responsible_fio, counterparty_name = excluded.counterparty_name,
          goods_total_positions = excluded.goods_total_positions, goods_available_positions = excluded.goods_available_positions, payment_status = excluded.payment_status, amount_due_minor = excluded.amount_due_minor,
          card_amount_due_minor = excluded.card_amount_due_minor, cash_amount_due_minor = excluded.cash_amount_due_minor, cash_discount_hundredths = excluded.cash_discount_hundredths
      `);
      this.testSaveStatement = this.database.prepare(`
        INSERT INTO test_repair_cards (document_id, number, date, vehicle_name, status, responsible_fio, counterparty_name, goods_total_positions, goods_available_positions, payment_status, amount_due_minor, card_amount_due_minor, cash_amount_due_minor, cash_discount_hundredths) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(document_id) DO UPDATE SET
          number = excluded.number, date = excluded.date,
          vehicle_name = excluded.vehicle_name, status = excluded.status, responsible_fio = excluded.responsible_fio, counterparty_name = excluded.counterparty_name,
          goods_total_positions = excluded.goods_total_positions, goods_available_positions = excluded.goods_available_positions, payment_status = excluded.payment_status, amount_due_minor = excluded.amount_due_minor,
          card_amount_due_minor = excluded.card_amount_due_minor, cash_amount_due_minor = excluded.cash_amount_due_minor, cash_discount_hundredths = excluded.cash_discount_hundredths
      `);
      this.refreshes = new RepairRefreshService(this.database, () => this.list(true), (id, test) => {
        const table = test ? "test_repair_cards" : "repair_cards";
        return JSON.stringify(this.database.prepare(`SELECT * FROM ${table} WHERE document_id=?`).get(id) ?? null);
      }, (result, test) => {
        for (const card of result.repairs) this.save(card);
        for (const id of result.removedDocumentIds) this.remove(id, test);
      });
      this.listStatement = this.database.prepare(`
        SELECT document_id AS documentId, number, date, vehicle_name AS vehicleName, status, responsible_fio AS responsibleFio, counterparty_name AS counterpartyName, goods_total_positions AS goodsTotalPositions, goods_available_positions AS goodsAvailablePositions, payment_status AS paymentStatus, amount_due_minor AS amountDueMinor, card_amount_due_minor AS cardAmountDueMinor, cash_amount_due_minor AS cashAmountDueMinor, cash_discount_hundredths AS cashDiscountHundredths, 0 AS testPlatform
        FROM repair_cards WHERE status = 'В работе' OR ? = 1
        UNION ALL
        SELECT document_id AS documentId, number, date, vehicle_name AS vehicleName, status, responsible_fio AS responsibleFio, counterparty_name AS counterpartyName, goods_total_positions AS goodsTotalPositions, goods_available_positions AS goodsAvailablePositions, payment_status AS paymentStatus, amount_due_minor AS amountDueMinor, card_amount_due_minor AS cardAmountDueMinor, cash_amount_due_minor AS cashAmountDueMinor, cash_discount_hundredths AS cashDiscountHundredths, 1 AS testPlatform
        FROM test_repair_cards WHERE status = 'В работе' OR ? = 1
        ORDER BY date DESC, documentId ASC, testPlatform ASC
      `);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  save(card: RepairCard): void {
    const statement = card.testPlatform === true ? this.testSaveStatement : this.saveStatement;
    statement.run(card.documentId, card.number, card.date, card.vehicleName, card.status, card.responsibleFio ?? null, card.counterpartyName ?? null, card.goodsReadiness?.totalPositions ?? null, card.goodsReadiness?.availablePositions ?? null, card.paymentStatus ?? null,
      card.amountDue !== undefined ? Math.round(card.amountDue * 100) : null,
      card.paymentOptions !== undefined ? Math.round(card.paymentOptions.cardAmountDue * 100) : null,
      card.paymentOptions?.cashAmountDue != null ? Math.round(card.paymentOptions.cashAmountDue * 100) : null,
      card.paymentOptions?.cashDiscountPercent != null ? Math.round(card.paymentOptions.cashDiscountPercent * 100) : null);
  }

  list(includeInactive = false): RepairCard[] {
    return this.listStatement.all(Number(includeInactive), Number(includeInactive)).map((row) => {
      const { documentId, number, date, vehicleName, status, responsibleFio, counterpartyName, paymentStatus } = row;
      if (typeof documentId !== "string" || typeof number !== "string" || typeof date !== "string"
        || typeof vehicleName !== "string" || typeof status !== "string") {
        throw new Error("Invalid SQLite repair card");
      }
      if (row.testPlatform !== 0 && row.testPlatform !== 1) throw new Error("Invalid SQLite repair platform");
      if (counterpartyName !== null && typeof counterpartyName !== "string") throw new Error("Invalid SQLite repair counterparty");
      if (responsibleFio !== null && typeof responsibleFio !== "string") throw new Error("Invalid SQLite repair responsible FIO");
      if (paymentStatus !== null && paymentStatus !== "paid" && paymentStatus !== "payment_required" && paymentStatus !== "partially_paid") throw new Error("Invalid SQLite repair payment status");
      const due = row.amountDueMinor;
      if (due !== null && (typeof due !== "number" || !Number.isSafeInteger(due) || due < 0
        || paymentStatus === null || (paymentStatus === "paid" ? due !== 0 : due <= 0))) throw new Error("Invalid SQLite repair amount due");
      if (paymentStatus === "partially_paid" && due === null) throw new Error("Missing SQLite repair amount due");
      const optionValues = [row.cardAmountDueMinor, row.cashAmountDueMinor, row.cashDiscountHundredths];
      if (optionValues.some((value) => value !== null && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0))
        || row.cardAmountDueMinor === null && optionValues.some((value) => value !== null)
        || row.cardAmountDueMinor !== null && (paymentStatus === null || due === null)) throw new Error("Invalid SQLite repair payment options");
      const paymentOptions = typeof row.cardAmountDueMinor === "number" ? parseRepairPaymentOptions({
        cardAmountDue: row.cardAmountDueMinor / 100,
        cashAmountDue: typeof row.cashAmountDueMinor === "number" ? row.cashAmountDueMinor / 100 : null,
        cashDiscountPercent: typeof row.cashDiscountHundredths === "number" ? row.cashDiscountHundredths / 100 : null,
      }) : undefined;
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
        ...(paymentStatus !== null ? { paymentStatus } : {}),
        ...(typeof due === "number" ? { amountDue: due / 100 } : {}),
        ...(paymentOptions !== undefined ? { paymentOptions } : {}),
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
    this.refreshes.close();
    this.database.close();
  }
}
