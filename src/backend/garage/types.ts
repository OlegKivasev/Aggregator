import type { NormalizedSearchResult, SupplierId } from "../types.ts";

export type GarageAvailabilityStatus = "available" | "unknown" | "insufficient" | "not_found" | "supplier_error";

export interface GarageVehicle {
  id: string;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface GarageItem {
  id: string;
  vehicleId: string;
  revision: number;
  supplier: SupplierId;
  brand: string;
  article: string;
  title: string;
  warehouse: string | null;
  deliveryDate: string | null;
  link: string;
  supplierQuantity: number | null;
  requiredQuantity: number;
  purchasePrice: number;
  markupPercent: number;
  regularPrice: number;
  comment: string;
  lastCheckedAt: string | null;
  availabilityStatus: GarageAvailabilityStatus;
}

export interface GarageVehicleDetails extends GarageVehicle {
  items: GarageItem[];
}

export interface GarageSearchOffer {
  result: NormalizedSearchResult;
  expiresAt: number;
}

export interface GarageRepository {
  listVehicles(search: string): GarageVehicle[];
  getVehicle(id: string): GarageVehicleDetails | null;
  createVehicle(vehicle: GarageVehicle): GarageVehicle;
  renameVehicle(id: string, revision: number, name: string, updatedAt: string): GarageVehicle | "conflict" | null;
  deleteVehicle(id: string, revision: number): "deleted" | "conflict" | "missing";
  createItem(item: GarageItem, vehicleRevision: number, updatedAt: string): "created" | "conflict" | "missing";
  findDuplicate(vehicleId: string, supplier: SupplierId, brand: string, article: string, warehouse: string | null): GarageItem | null;
  incrementItem(id: string, revision: number, increment: number, updatedAt: string): GarageItem | "conflict" | "missing";
  updateItem(id: string, revision: number, requiredQuantity: number, comment: string, updatedAt: string): GarageItem | "conflict" | "missing";
  deleteItem(id: string, revision: number, updatedAt: string): "deleted" | "conflict" | "missing";
  refreshItem(item: GarageItem, updatedAt: string): void;
  close(): void;
}

export interface GarageOfferLookup {
  findOffers(article: string, supplier: SupplierId, signal: AbortSignal): Promise<{
    results: NormalizedSearchResult[];
    failed: boolean;
  }>;
}
