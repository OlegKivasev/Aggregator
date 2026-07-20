export type SupplierId = "rossko" | "armtek" | "part-kom" | "stparts" | "motordetal" | "mladov";

export type SupplierSearchStatus =
  | "searching"
  | "completed"
  | "timeout"
  | "auth_error"
  | "error";

export interface SearchQuery {
  article: string;
  suppliers?: SupplierId[];
}

export interface NormalizedSearchResult {
  supplier: SupplierId;
  brand: string;
  article: string;
  title: string;
  price: number;
  warehouse: string | null;
  warehouseFull?: string | null;
  warehouseColor?: "green" | "blue" | "red" | null;
  warehouseRating?: string | null;
  deliveryDate: string | null;
  deliveryDateTo?: string | null;
  deliveryDateApproximate: boolean;
  link: string;
}

export interface SupplierSessionState {
  supplier: SupplierId;
  authorized: boolean;
  lastCheckedAt: string | null;
  lastAuthorizedAt: string | null;
  details?: string;
}

export interface SupplierSessionValidationResult {
  supplier: SupplierId;
  status: "connected" | "expired" | "error";
}

export interface RosskoSiteCredentials {
  login: string;
  password: string;
}

export interface ArmtekCredentials {
  login: string;
  password: string;
}

export interface PartKomCredentials {
  login: string;
  password: string;
}

export interface StpartsCredentials {
  login: string;
  password: string;
}

export interface MotorDetalCredentials {
  login: string;
  password: string;
}

export interface MladovCredentials {
  login: string;
  password: string;
}

export interface SupplierSearchContext {
  signal: AbortSignal;
  timeoutMs: number;
}

export interface SearchSupplierStatusEvent {
  type: "supplier_status";
  supplier: SupplierId;
  status: SupplierSearchStatus;
  details?: string;
}

export interface SearchResultEvent {
  type: "result";
  result: NormalizedSearchResult;
}

export interface SearchStartedEvent {
  type: "search_started";
  article: string;
  suppliers: SupplierId[];
}

export interface SearchCompletedEvent {
  type: "search_completed";
  article: string;
}

export interface SearchFatalEvent {
  type: "fatal_error";
  message: string;
}

export type SearchStreamEvent =
  | SearchSupplierStatusEvent
  | SearchResultEvent
  | SearchStartedEvent
  | SearchCompletedEvent
  | SearchFatalEvent;
