import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { GarageAvailabilityStatus, GarageItem, GarageRepository, GarageVehicle, GarageVehicleDetails } from "./types.ts";
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

function mapItem(row: SqlRow): GarageItem {
  return {
    id: text(row, "id"), vehicleId: text(row, "vehicle_id"), revision: number(row, "revision"), supplier: text(row, "supplier") as SupplierId,
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
      CREATE INDEX IF NOT EXISTS garage_items_vehicle_id ON garage_items(vehicle_id);
    `);
  }

  listVehicles(search: string): GarageVehicle[] {
    const term = `%${search.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    return this.database.prepare("SELECT * FROM garage_vehicles WHERE name LIKE ? ESCAPE '\\' ORDER BY updated_at DESC, name COLLATE NOCASE ASC")
      .all(term).map((row) => mapVehicle(row));
  }

  getVehicle(id: string): GarageVehicleDetails | null {
    const vehicle = this.database.prepare("SELECT * FROM garage_vehicles WHERE id = ?").get(id);
    if (!vehicle) return null;
    const items = this.database.prepare("SELECT * FROM garage_items WHERE vehicle_id = ? ORDER BY rowid ASC").all(id)
      .map((row) => mapItem(row));
    return { ...mapVehicle(vehicle), items };
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

  createItem(item: GarageItem, vehicleRevision: number, updatedAt: string): "created" | "conflict" | "missing" {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const vehicle = this.database.prepare("SELECT revision FROM garage_vehicles WHERE id = ?").get(item.vehicleId) as { revision: number } | undefined;
      if (!vehicle) { this.database.exec("ROLLBACK"); return "missing"; }
      if (vehicle.revision !== vehicleRevision) { this.database.exec("ROLLBACK"); return "conflict"; }
      this.database.prepare(`INSERT INTO garage_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(item.id, item.vehicleId, item.revision, item.supplier, item.brand, item.article, item.title, item.warehouse,
          item.deliveryDate, item.link, item.supplierQuantity, item.requiredQuantity, item.purchasePrice, item.markupPercent,
          item.regularPrice, item.comment, item.lastCheckedAt, item.availabilityStatus);
      this.database.prepare("UPDATE garage_vehicles SET revision = revision + 1, updated_at = ? WHERE id = ?").run(updatedAt, item.vehicleId);
      this.database.exec("COMMIT");
      return "created";
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  findDuplicate(vehicleId: string, supplier: SupplierId, brand: string, article: string, warehouse: string | null): GarageItem | null {
    if (warehouse === null) return null;
    const row = this.database.prepare("SELECT * FROM garage_items WHERE vehicle_id = ? AND supplier = ? AND brand = ? AND article = ? AND warehouse = ?")
      .get(vehicleId, supplier, brand, article, warehouse);
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

  updateItem(id: string, revision: number, requiredQuantity: number, comment: string, updatedAt: string): GarageItem | "conflict" | "missing" {
    const item = this.database.prepare("SELECT vehicle_id FROM garage_items WHERE id = ?").get(id) as { vehicle_id: string } | undefined;
    if (!item) return "missing";
    const result = this.database.prepare("UPDATE garage_items SET required_quantity = ?, comment = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
      .run(requiredQuantity, comment, id, revision);
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

  close(): void { this.database.close(); }
}
