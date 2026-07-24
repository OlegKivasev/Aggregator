import type {
  NormalizedSearchResult,
  SearchQuery,
  SupplierId,
  SupplierSearchContext,
  SupplierSessionState,
} from "../types.ts";
import type { SupplierSessionManager } from "../session/session-manager.ts";

export interface SupplierAdapter {
  readonly id: SupplierId;
  readonly displayName: string;
  readonly timeoutMs: number;

  ensureSession(sessionManager: SupplierSessionManager): Promise<SupplierSessionState>;
  validateSession?(context: SupplierSearchContext, sessionManager: SupplierSessionManager): Promise<void>;
  search(
    query: SearchQuery,
    context: SupplierSearchContext,
    onResult: (result: NormalizedSearchResult) => void,
    sessionManager: SupplierSessionManager,
  ): Promise<void>;
}
