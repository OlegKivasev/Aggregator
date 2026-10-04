import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { GarageAvailabilityStatus, GarageGroup, GarageItem, GarageRepository, GarageVehicle, GarageVehicleDetails } from "./types.ts";
import type { SupplierId } from "../types.ts";

type SqlRow = Record<string, string | number | bigint | Uint8Array | null>;

function text(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Invalid SQLite ${key}`);
  return value;
}
function number(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid SQLite ${key}`);
  return value;
}
function nullableText(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== "string") throw new Error(`Invalid SQLite ${key}`);
  return value;
}
function nullableNumber(row: SqlRow, key: string): number | null {
  const value = row[key];
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`Invalid SQLite ${key}`);
  return value;
}
function mapVehicle(row: SqlRow): GarageVehicle {
  return { id: text(row, "id"), name: text(row, "name"), revision: number(row, "revision"), createdAt: text(row, "created_at"), updatedAt: text(row, "updated_at") };
}

function mapGroup(row: SqlRow): GarageGroup {
  return {
    id: text(row, "id"), vehicleId: text(row, "vehicle_id"), revision: number(row, "revision"), name: text(row, "name"),
    createdAt: text(row, "created_at"), updatedAt: text(row, "updated_at"),
  };
}

function mapItem(row: SqlRow): GarageItem {
  return {
    id: text(row, "id"), vehicleId: text(row, "vehicle_id"), groupId: nullableText(row, "group_id"), revision: number(row, "revision"), supplier: text(row, "supplier") as SupplierId,
    brand: text(row, "brand"), article: text(row, "article"), title: text(row, "title"), warehouse: nullableText(row, "warehouse"),
    deliveryDate: nullableText(row, "delivery_date"), link: text(row, "link"), supplierQuantity: nullableNumber(row, "supplier_quantity"),
    requiredQuantity: number(row, "required_quantity"), purchasePrice: number(row, "purchase_price"), markupPercent: number(row, "markup_percent"),
    regularPrice: number(row, "regular_price"), comment: text(row, "comment"), lastCheckedAt: nullableText(row, "last_checked_at"),
    availabilityStatus: text(row, "availability_status") as GarageAvailabilityStatus,
  };
}

export class SqliteGarageRepository implements GarageRepository {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS garage_vehicles (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS garage_items (
        id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL REFERENCES garage_vehicles(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, supplier TEXT NOT NULL, brand TEXT NOT NULL, article TEXT NOT NULL,
        title TEXT NOT NULL, warehouse TEXT, delivery_date TEXT, link TEXT NOT NULL,
        supplier_quantity REAL, required_quantity REAL NOT NULL, purchase_price REAL NOT NULL,
        markup_percent REAL NOT NULL, regular_price REAL NOT NULL, comment TEXT NOT NULL,
        last_checked_at TEXT, availability_status TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS garage_groups (
        id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL REFERENCES garage_vehicles(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ui_preferences (
        preference_key TEXT PRIMARY KEY, preference_value TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS garage_items_vehicle_id ON garage_items(vehicle_id);
      CREATE INDEX IF NOT EXISTS garage_groups_vehicle_id ON garage_groups(vehicle_id);
    `);
    const itemColumns = this.database.prepare("PRAGMA table_info(garage_items)").all() as SqlRow[];
    if (!itemColumns.some((column) => text(column, "name") === "group_id")) {
      this.database.exec("ALTER TABLE garage_items ADD COLUMN group_id TEXT");
    }
  }

  listVehicles(search: string): GarageVehicle[] {
    const term = `%${search.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    return this.database.prepare("SELECT * FROM garage_vehicles WHERE name LIKE ? ESCAPE '\\' ORDER BY updated_at DESC, name COLLATE NOCASE ASC")
      .all(term).map((row) => mapVehicle(row));
  }

  getVehicle(id: string): GarageVehicleDetails | null {
    const vehicle = this.database.prepare("SELECT * FROM garage_vehicles WHERE id = ?").get(id);
    if (!vehicle) return null;
    const groups = this.database.prepare("SELECT * FROM garage_groups WHERE vehicle_id = ? ORDER BY created_at ASC, name COLLATE NOCASE ASC").all(id)
      .map((row) => mapGroup(row));
    const items = this.database.prepare("SELECT * FROM garage_items WHERE vehicle_id = ? ORDER BY rowid ASC").all(id)
      .map((row) => mapItem(row));
    return { ...mapVehicle(vehicle), groups, items };
  }

  createVehicle(vehicle: GarageVehicle): GarageVehicle {
    this.database.prepare("INSERT INTO garage_vehicles VALUES (?, ?, ?, ?, ?)")
      .run(vehicle.id, vehicle.name, vehicle.revision, vehicle.createdAt, vehicle.updatedAt);
    return vehicle;
  }

  renameVehicle(id: string, revision: number, name: string, updatedAt: string): GarageVehicle | "conflict" | null {
    const result = this.database.prepare("UPDATE garage_vehicles SET name = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?")
      .run(name, updatedAt, id, revision);
    if (result.changes === 0) return this.getVehicle(id) ? "conflict" : null;
    return this.getVehicle(id)!;
  }

  deleteVehicle(id: string, revision: number): "deleted" | "conflict" | "missing" {
    const result = this.database.prepare("DELETE FROM garage_vehicles WHERE id = ? AND revision = ?").run(id, revision);
    if (result.changes) return "deleted";
    return this.getVehicle(id) ? "conflict" : "missing";
  }

  createGroup(group: GarageGroup, vehicleRevision: number, updatedAt: string): "created" | "conflict" | "missing" {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const vehicle = this.database.prepare("SELECT revision FROM garage_vehicles WHERE id = ?").get(group.vehicleId) as { revision: number } | undefined;
      if (!vehicle) { this.database.exec("ROLLBACK"); return "missing"; }
      if (vehicle.revision !== vehicleRevision) { this.database.exec("ROLLBACK"); return "conflict"; }
      this.database.prepare("INSERT INTO garage_groups VALUES (?, ?, ?, ?, ?, ?)")
        .run(group.id, group.vehicleId, group.revision, group.name, group.createdAt, group.updatedAt);
      this.database.prepare("UPDATE garage_vehicles SET revision = revision + 1, updated_at = ? WHERE id = ?").run(updatedAt, group.vehicleId);
      this.database.exec("COMMIT");
      return "created";
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  createItem(item: GarageItem, vehicleRevision: number, updatedAt: string): "created" | "conflict" | "missing" {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const vehicle = this.database.prepare("SELECT revision FROM garage_vehicles WHERE id = ?").get(item.vehicleId) as { revision: number } | undefined;
      if (!vehicle) { this.database.exec("ROLLBACK"); return "missing"; }
      if (vehicle.revision !== vehicleRevision) { this.database.exec("ROLLBACK"); return "conflict"; }
    this.database.prepare(`INSERT INTO garage_items (id, vehicle_id, revision, supplier, brand, article, title, warehouse, delivery_date, link,
      supplier_quantity, required_quantity, purchase_price, markup_percent, regular_price, comment, last_checked_at, availability_status, group_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(item.id, item.vehicleId, item.revision, item.supplier, item.brand, item.article, item.title, item.warehouse,
          item.deliveryDate, item.link, item.supplierQuantity, item.requiredQuantity, item.purchasePrice, item.markupPercent,
          item.regularPrice, item.comment, item.lastCheckedAt, item.availabilityStatus, item.groupId);
      this.database.prepare("UPDATE garage_vehicles SET revision = revision + 1, updated_at = ? WHERE id = ?").run(updatedAt, item.vehicleId);
      this.database.exec("COMMIT");
      return "created";
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  findGroup(id: string): GarageGroup | null {
    const row = this.database.prepare("SELECT * FROM garage_groups WHERE id = ?").get(id);
    return row ? mapGroup(row) : null;
  }

  findItem(id: string): GarageItem | null {
    const row = this.database.prepare("SELECT * FROM garage_items WHERE id = ?").get(id);
    return row ? mapItem(row) : null;
  }

  findDuplicate(vehicleId: string, groupId: string | null, supplier: SupplierId, brand: string, article: string, warehouse: string | null): GarageItem | null {
    if (warehouse === null) return null;
    const groupMatch = groupId === null ? "group_id IS NULL" : "group_id = ?";
    const values = groupId === null
      ? [vehicleId, supplier, brand, article, warehouse]
      : [vehicleId, supplier, brand, article, warehouse, groupId];
    const row = this.database.prepare(`SELECT * FROM garage_items WHERE vehicle_id = ? AND supplier = ? AND brand = ? AND article = ? AND warehouse = ? AND ${groupMatch}`)
      .get(...values);
    return row ? mapItem(row) : null;
  }

  incrementItem(id: string, revision: number, increment: number, updatedAt: string): GarageItem | "conflict" | "missing" {
    const item = this.database.prepare("SELECT vehicle_id FROM garage_items WHERE id = ?").get(id) as { vehicle_id: string } | undefined;
    if (!item) return "missing";
    const result = this.database.prepare("UPDATE garage_items SET required_quantity = required_quantity + ?, revision = revision + 1 WHERE id = ? AND revision = ?")
      .run(increment, id, revision);
    if (!result.changes) return "conflict";
    this.database.prepare("UPDATE garage_vehicles SET revision = revision + 1, updated_at = ? WHERE id = ? ").run(updatedAt, item.vehicle_id);
    return mapItem(this.database.prepare("SELECT * FROM garage_items WHERE id = ?").get(id)!);
  }

  updateItem(id: string, revision: number, requiredQuantity: number, comment: string, groupId: string | null, updatedAt: string): GarageItem | "conflict" | "missing" {
    const item = this.database.prepare("SELECT vehicle_id FROM garage_items WHERE id = ?").get(id) as { vehicle_id: string } | undefined;
    if (!item) return "missing";
    const result = this.database.prepare("UPDATE garage_items SET required_quantity = ?, comment = ?, group_id = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
      .run(requiredQuantity, comment, groupId, id, revision);
    if (!result.changes) return "conflict";
    this.database.prepare("UPDATE garage_vehicles SET revision = revision + 1, updated_at = ? WHERE id = ?").run(updatedAt, item.vehicle_id);
    return mapItem(this.database.prepare("SELECT * FROM garage_items WHERE id = ?").get(id)!);
  }

  deleteItem(id: string, revision: number, updatedAt: string): "deleted" | "conflict" | "missing" {
    const item = this.database.prepare("SELECT vehicle_id FROM garage_items WHERE id = ?").get(id) as { vehicle_id: string } | undefined;
    if (!item) return "missing";
    const result = this.database.prepare("DELETE FROM garage_items WHERE id = ? AND revision = ?").run(id, revision);
    if (!result.changes) return "conflict";
    this.database.prepare("UPDATE garage_vehicles SET revision = revision + 1, updated_at = ? WHERE id = ?").run(updatedAt, item.vehicle_id);
    return "deleted";
  }

  refreshItem(item: GarageItem, updatedAt: string): void {
    this.database.prepare(`UPDATE garage_items SET supplier = ?, brand = ?, article = ?, title = ?, warehouse = ?, delivery_date = ?, link = ?,
      supplier_quantity = ?, purchase_price = ?, markup_percent = ?, regular_price = ?, last_checked_at = ?, availability_status = ?, revision = revision + 1 WHERE id = ?`)
      .run(item.supplier, item.brand, item.article, item.title, item.warehouse, item.deliveryDate, item.link, item.supplierQuantity,
        item.purchasePrice, item.markupPercent, item.regularPrice, item.lastCheckedAt, item.availabilityStatus, item.id);
    this.database.prepare("UPDATE garage_vehicles SET revision = revision + 1, updated_at = ? WHERE id = ?").run(updatedAt, item.vehicleId);
  }

  getUiPreference(key: string): string | null {
    const row = this.database.prepare("SELECT preference_value FROM ui_preferences WHERE preference_key = ?").get(key) as SqlRow | undefined;
    return row ? text(row, "preference_value") : null;
  }

  setUiPreference(key: string, value: string): void {
    this.database.prepare(`INSERT INTO ui_preferences (preference_key, preference_value) VALUES (?, ?)
      ON CONFLICT(preference_key) DO UPDATE SET preference_value = excluded.preference_value`).run(key, value);
  }

  close(): void { this.database.close(); }
}
