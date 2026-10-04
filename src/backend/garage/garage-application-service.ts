import { randomUUID } from "node:crypto";
import type { NormalizedSearchResult } from "../types.ts";
import type { GarageAvailabilityStatus, GarageGroup, GarageItem, GarageOfferLookup, GarageRepository, GarageSearchOffer, GarageVehicle, GarageVehicleDetails } from "./types.ts";

const maxNameLength = 120;
const maxCommentLength = 1_000;
const offerLifetimeMs = 5 * 60_000;
const tableWidthPreferenceKey = "table-column-widths-v1";
const tableColumns = {
  main: ["supplier", "brand", "article", "title", "deliveryDate", "quantity", "markupPrice"],
  analogs: ["supplier", "brand", "article", "title", "deliveryDate", "quantity", "markupPrice"],
  garage: ["supplier", "brand", "article", "title", "deliveryDate", "availability", "quantity", "price", "sum"],
} as const;
const minimumColumnWidth = 80;
const maximumColumnWidth = 800;

type TableName = keyof typeof tableColumns;
type TableColumnWidths = Partial<Record<(typeof tableColumns)[TableName][number], number>>;
type TableWidthPreferences = Partial<Record<TableName, TableColumnWidths>>;

export class GarageValidationError extends Error {}
export class GarageConflictError extends Error {}
export class GarageNotFoundError extends Error {}
export class GarageOfferExpiredError extends Error {}

function now(): string { return new Date().toISOString(); }
function normalizeText(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== "string") throw new GarageValidationError(`${label} must be a string`);
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > maximumLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new GarageValidationError(`${label} is invalid`);
  }
  return normalized;
}
function normalizeComment(value: unknown): string {
  if (typeof value !== "string" || value.length > maxCommentLength || /\u0000/.test(value)) throw new GarageValidationError("comment is invalid");
  return value.trim();
}
function normalizeQuantity(value: unknown): number {
  const quantity = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) throw new GarageValidationError("requiredQuantity is invalid");
  return quantity;
}
function normalizeRevision(value: unknown): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) throw new GarageValidationError("revision is invalid");
  return value;
}
function normalizeMarkup(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000) throw new GarageValidationError("markupPercent is invalid");
  return value;
}
function normalizeGroupId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new GarageValidationError("groupId is invalid");
  }
  return value;
}
function sameText(left: string, right: string): boolean { return left.trim().toLocaleLowerCase("ru-RU") === right.trim().toLocaleLowerCase("ru-RU"); }
function safeLink(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new GarageValidationError("offer link is invalid");
  return url.toString();
}
function isValidDate(value: string | null): boolean {
  return value === null || (/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(value) && Number.isFinite(Date.parse(value)));
}
function availability(quantity: number | null, required: number): GarageAvailabilityStatus {
  if (quantity === null) return "unknown";
  return quantity < required ? "insufficient" : "available";
}
function regularPrice(price: number, markup: number): number { return Math.round(price * (1 + markup / 100) * 100) / 100; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function normalizeTableColumnWidths(value: unknown): TableWidthPreferences {
  if (!isRecord(value)) throw new GarageValidationError("table column widths are invalid");
  const preferences: TableWidthPreferences = {};
  for (const [table, columns] of Object.entries(tableColumns) as [TableName, readonly string[]][]) {
    const savedWidths = value[table];
    if (savedWidths === undefined) continue;
    if (!isRecord(savedWidths)) throw new GarageValidationError("table column widths are invalid");
    const widths: Record<string, number> = {};
    for (const [column, width] of Object.entries(savedWidths)) {
      if (typeof width !== "number" || !columns.includes(column) || !Number.isInteger(width) || width < minimumColumnWidth || width > maximumColumnWidth) {
        throw new GarageValidationError("table column widths are invalid");
      }
      widths[column] = width;
    }
    preferences[table] = widths;
  }
  if (Object.keys(value).some((table) => !(table in tableColumns))) throw new GarageValidationError("table column widths are invalid");
  return preferences;
}

export class GarageApplicationService {
  private readonly offers = new Map<string, GarageSearchOffer>();
  private readonly repository: GarageRepository;
  private readonly offerLookup: GarageOfferLookup;

  constructor(repository: GarageRepository, offerLookup: GarageOfferLookup) {
    this.repository = repository;
    this.offerLookup = offerLookup;
  }

  registerSearchOffer(result: NormalizedSearchResult): string {
    this.purgeExpiredOffers();
    const id = randomUUID();
    this.offers.set(id, { result: structuredClone(result), expiresAt: Date.now() + offerLifetimeMs });
    return id;
  }

  listVehicles(search: unknown): GarageVehicle[] {
    const normalizedSearch = search === undefined ? "" : typeof search === "string" && search.length <= maxNameLength ? search.trim() : (() => { throw new GarageValidationError("search is invalid"); })();
    return this.repository.listVehicles(normalizedSearch);
  }

  getVehicle(id: string): GarageVehicleDetails {
    const vehicle = this.repository.getVehicle(id);
    if (!vehicle) throw new GarageNotFoundError();
    return vehicle;
  }

  createVehicle(name: unknown): GarageVehicle {
    const timestamp = now();
    return this.repository.createVehicle({ id: randomUUID(), name: normalizeText(name, "name", maxNameLength), revision: 1, createdAt: timestamp, updatedAt: timestamp });
  }

  renameVehicle(id: string, revision: unknown, name: unknown): GarageVehicle {
    const result = this.repository.renameVehicle(id, normalizeRevision(revision), normalizeText(name, "name", maxNameLength), now());
    if (result === "conflict") throw new GarageConflictError();
    if (!result) throw new GarageNotFoundError();
    return result;
  }

  deleteVehicle(id: string, revision: unknown): void {
    const result = this.repository.deleteVehicle(id, normalizeRevision(revision));
    if (result === "conflict") throw new GarageConflictError();
    if (result === "missing") throw new GarageNotFoundError();
  }

  createGroup(vehicleId: string, vehicleRevision: unknown, name: unknown): GarageGroup {
    const timestamp = now();
    const group: GarageGroup = {
      id: randomUUID(), vehicleId, revision: 1, name: normalizeText(name, "name", maxNameLength), createdAt: timestamp, updatedAt: timestamp,
    };
    const result = this.repository.createGroup(group, normalizeRevision(vehicleRevision), timestamp);
    if (result === "conflict") throw new GarageConflictError();
    if (result === "missing") throw new GarageNotFoundError();
    return group;
  }

  renameGroup(vehicleId: string, groupId: string, vehicleRevision: unknown, name: unknown): GarageGroup {
    const normalizedGroupId = normalizeGroupId(groupId);
    if (normalizedGroupId === null) throw new GarageValidationError("groupId is invalid");
    const result = this.repository.renameGroup(vehicleId, normalizedGroupId, normalizeRevision(vehicleRevision), normalizeText(name, "name", maxNameLength), now());
    if (result === "conflict") throw new GarageConflictError();
    if (result === "missing") throw new GarageNotFoundError();
    return result;
  }

  deleteGroup(vehicleId: string, groupId: string, vehicleRevision: unknown): void {
    const normalizedGroupId = normalizeGroupId(groupId);
    if (normalizedGroupId === null) throw new GarageValidationError("groupId is invalid");
    const result = this.repository.deleteGroup(vehicleId, normalizedGroupId, normalizeRevision(vehicleRevision), now());
    if (result === "conflict") throw new GarageConflictError();
    if (result === "missing") throw new GarageNotFoundError();
  }

  addOffer(vehicleId: string, vehicleRevision: unknown, offerId: unknown, markupPercent: unknown, requiredQuantity: unknown, strategy: unknown, groupId: unknown): GarageItem | { duplicate: GarageItem } {
    const offer = this.getOffer(offerId);
    const revision = normalizeRevision(vehicleRevision);
    const quantity = normalizeQuantity(requiredQuantity);
    const markup = normalizeMarkup(markupPercent);
    const normalizedGroupId = this.groupForVehicle(vehicleId, groupId);
    const snapshot = offer.result;
    if (typeof snapshot.quantity === "number" && Number.isFinite(snapshot.quantity) && snapshot.quantity >= 0 && quantity > snapshot.quantity) {
      throw new GarageValidationError("requiredQuantity exceeds supplier quantity");
    }
    const duplicate = this.repository.findDuplicate(vehicleId, normalizedGroupId, snapshot.supplier, snapshot.brand, snapshot.article, snapshot.warehouse);
    if (duplicate && strategy === undefined) return { duplicate };
    if (strategy === "increment") {
      if (!duplicate) throw new GarageConflictError();
      if (typeof snapshot.quantity === "number" && Number.isFinite(snapshot.quantity) && duplicate.requiredQuantity + quantity > snapshot.quantity) {
        throw new GarageValidationError("requiredQuantity exceeds supplier quantity");
      }
      const result = this.repository.incrementItem(duplicate.id, duplicate.revision, quantity, now());
      if (result === "conflict") throw new GarageConflictError();
      if (result === "missing") throw new GarageNotFoundError();
      return result;
    }
    if (strategy !== undefined && strategy !== "new") throw new GarageValidationError("duplicateStrategy is invalid");
    const item = this.itemFromOffer(vehicleId, normalizedGroupId, snapshot, quantity, markup);
    const result = this.repository.createItem(item, revision, now());
    if (result === "conflict") throw new GarageConflictError();
    if (result === "missing") throw new GarageNotFoundError();
    return item;
  }

  updateItem(id: string, revision: unknown, requiredQuantity: unknown, comment: unknown, groupId: unknown): GarageItem {
    const item = this.repository.findItem(id);
    if (!item) throw new GarageNotFoundError();
    const result = this.repository.updateItem(id, normalizeRevision(revision), normalizeQuantity(requiredQuantity), normalizeComment(comment), this.groupForVehicle(item.vehicleId, groupId), now());
    if (result === "conflict") throw new GarageConflictError();
    if (result === "missing") throw new GarageNotFoundError();
    return result;
  }

  deleteItem(id: string, revision: unknown): void {
    const result = this.repository.deleteItem(id, normalizeRevision(revision), now());
    if (result === "conflict") throw new GarageConflictError();
    if (result === "missing") throw new GarageNotFoundError();
  }

  async refreshVehicle(id: string, revision: unknown, signal: AbortSignal): Promise<GarageVehicleDetails> {
    const vehicle = this.getVehicle(id);
    if (vehicle.revision !== normalizeRevision(revision)) throw new GarageConflictError();
    const limit = 3;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, vehicle.items.length) }, async () => {
      while (!signal.aborted) {
        const item = vehicle.items[cursor++];
        if (!item) return;
        await this.refreshItem(item, signal);
      }
    });
    await Promise.all(workers);
    if (signal.aborted) throw signal.reason;
    return this.getVehicle(id);
  }

  getTableColumnWidths(): TableWidthPreferences {
    const savedValue = this.repository.getUiPreference(tableWidthPreferenceKey);
    if (savedValue === null) return {};
    try {
      return normalizeTableColumnWidths(JSON.parse(savedValue));
    } catch {
      // A corrupted optional preference must not block access to garage data.
      return {};
    }
  }

  setTableColumnWidths(value: unknown): TableWidthPreferences {
    const preferences = normalizeTableColumnWidths(value);
    this.repository.setUiPreference(tableWidthPreferenceKey, JSON.stringify(preferences));
    return preferences;
  }

  close(): void { this.repository.close(); }

  private getOffer(value: unknown): GarageSearchOffer {
    if (typeof value !== "string") throw new GarageValidationError("offerId is invalid");
    const offer = this.offers.get(value);
    if (!offer || offer.expiresAt < Date.now()) {
      this.offers.delete(value);
      throw new GarageOfferExpiredError();
    }
    return offer;
  }

  private purgeExpiredOffers(): void {
    for (const [id, offer] of this.offers) if (offer.expiresAt < Date.now()) this.offers.delete(id);
  }

  private groupForVehicle(vehicleId: string, value: unknown): string | null {
    const groupId = normalizeGroupId(value);
    if (!groupId) return null;
    const group = this.repository.findGroup(groupId);
    if (!group || group.vehicleId !== vehicleId) throw new GarageValidationError("groupId is invalid");
    return groupId;
  }

  private itemFromOffer(vehicleId: string, groupId: string | null, offer: NormalizedSearchResult, requiredQuantity: number, markupPercent: number): GarageItem {
    if (!Number.isFinite(offer.price) || offer.price <= 0 || !isValidDate(offer.deliveryDate)) throw new GarageValidationError("search offer is invalid");
    const quantity = typeof offer.quantity === "number" && Number.isFinite(offer.quantity) && offer.quantity >= 0 ? offer.quantity : null;
    return {
      id: randomUUID(), vehicleId, groupId, revision: 1, supplier: offer.supplier, brand: normalizeText(offer.brand, "brand", 120),
      article: normalizeText(offer.article, "article", 128), title: normalizeText(offer.title, "title", 500),
      warehouse: offer.warehouse === null ? null : normalizeText(offer.warehouse, "warehouse", 300), deliveryDate: offer.deliveryDate,
      link: safeLink(offer.link), supplierQuantity: quantity, requiredQuantity, purchasePrice: offer.price,
      markupPercent, regularPrice: regularPrice(offer.price, markupPercent), comment: "", lastCheckedAt: now(),
      availabilityStatus: availability(quantity, requiredQuantity),
    };
  }

  private async refreshItem(item: GarageItem, signal: AbortSignal): Promise<void> {
    const checkedAt = now();
    const lookup = await this.offerLookup.findOffers(item.article, item.supplier, signal);
    if (lookup.failed) {
      this.repository.refreshItem({ ...item, lastCheckedAt: checkedAt, availabilityStatus: "supplier_error" }, checkedAt);
      return;
    }
    const candidates = lookup.results.filter((result) => result.supplier === item.supplier && sameText(result.brand, item.brand) && sameText(result.article, item.article));
    const sameWarehouse = candidates.filter((result) => result.warehouse === item.warehouse);
    const matches = sameWarehouse.length === 1 ? sameWarehouse : candidates.length === 1 ? candidates : [];
    if (matches.length !== 1) {
      this.repository.refreshItem({ ...item, lastCheckedAt: checkedAt, availabilityStatus: "not_found" }, checkedAt);
      return;
    }
    const offer = matches[0];
    const quantity = typeof offer.quantity === "number" && Number.isFinite(offer.quantity) && offer.quantity >= 0 ? offer.quantity : null;
    this.repository.refreshItem({
      ...item, brand: offer.brand, article: offer.article, title: offer.title, warehouse: offer.warehouse, deliveryDate: offer.deliveryDate,
      link: safeLink(offer.link), supplierQuantity: quantity, purchasePrice: offer.price,
      regularPrice: regularPrice(offer.price, item.markupPercent), lastCheckedAt: checkedAt,
      availabilityStatus: availability(quantity, item.requiredQuantity),
    }, checkedAt);
  }
}
