import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { RequestBodyError } from "../http/request-body.ts";

export interface RepairVisibility {
  hideArticle: boolean;
  hideBrand: boolean;
}

interface UserPosition extends RepairVisibility {
  id: string;
  name: string;
}

export function parsePositionId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) {
    throw new RequestBodyError(400, "Укажите корректную должность.");
  }
  return value;
}

function positionPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestBodyError(400, "Требуются данные должности.");
  }
  return value as Record<string, unknown>;
}

export class UserPositionStore {
  private readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
    database.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
    try {
      database.exec(`CREATE TABLE IF NOT EXISTS aggregator_user_positions (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
        hide_article INTEGER NOT NULL CHECK (hide_article IN (0, 1)),
        hide_brand INTEGER NOT NULL CHECK (hide_brand IN (0, 1))
      ) STRICT;`);
      if (!database.prepare("PRAGMA table_info(aggregator_users)").all().some((column) => column.name === "position_id")) {
        database.exec("ALTER TABLE aggregator_users ADD COLUMN position_id TEXT REFERENCES aggregator_user_positions(id)");
      }
      database.exec(`CREATE INDEX IF NOT EXISTS aggregator_users_position_idx ON aggregator_users (position_id);
        COMMIT;`);
    } catch (error) { database.exec("ROLLBACK"); throw error; }
  }

  list(): UserPosition[] {
    return this.database.prepare("SELECT id, name, hide_article, hide_brand FROM aggregator_user_positions ORDER BY name_key").all()
      .map((row) => ({ id: row.id as string, name: row.name as string, hideArticle: row.hide_article === 1, hideBrand: row.hide_brand === 1 }));
  }

  requireExisting(id: string): void {
    if (!this.database.prepare("SELECT 1 FROM aggregator_user_positions WHERE id=?").get(id)) {
      throw new RequestBodyError(404, "Должность не найдена. Обновите список.");
    }
  }

  save(value: unknown, create: boolean): UserPosition {
    const { name: rawName, hideArticle, hideBrand, id: rawId } = positionPayload(value);
    const name = typeof rawName === "string" && !/[\u0000-\u001f\u007f-\u009f]/.test(rawName)
      ? rawName.trim().replace(/\s+/g, " ") : "";
    if (!name || name.length > 100) throw new RequestBodyError(400, "Укажите название должности длиной до 100 символов.");
    if (typeof hideArticle !== "boolean" || typeof hideBrand !== "boolean") {
      throw new RequestBodyError(400, "Укажите, какие поля скрывать в заказ-нарядах.");
    }
    const id = create ? randomBytes(16).toString("hex") : parsePositionId(rawId);
    const key = name.toLocaleLowerCase("ru-RU");
    const flags = [Number(hideArticle), Number(hideBrand)];
    const result = create
      ? this.database.prepare(`INSERT INTO aggregator_user_positions (id, name, name_key, hide_article, hide_brand)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(name_key) DO NOTHING`).run(id, name, key, ...flags)
      : this.database.prepare(`UPDATE aggregator_user_positions SET name=?, name_key=?, hide_article=?, hide_brand=?
          WHERE id=? AND NOT EXISTS (SELECT 1 FROM aggregator_user_positions WHERE name_key=? AND id<>?)`)
        .run(name, key, ...flags, id, key, id);
    if (!result.changes) {
      if (!create) this.requireExisting(id);
      throw new RequestBodyError(409, "Должность с таким названием уже есть.");
    }
    return { id, name, hideArticle, hideBrand };
  }

  delete(value: unknown): void {
    const id = parsePositionId(positionPayload(value).id);
    const result = this.database.prepare(`DELETE FROM aggregator_user_positions WHERE id=?
      AND NOT EXISTS (SELECT 1 FROM aggregator_users WHERE position_id=?)`).run(id, id);
    if (!result.changes) {
      this.requireExisting(id);
      throw new RequestBodyError(409, "Эта должность назначена сотрудникам. Сначала измените их должности.");
    }
  }
}
