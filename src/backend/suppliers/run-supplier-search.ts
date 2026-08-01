import { SupplierAuthError, SupplierIntegrationError, SupplierSessionInvalidatedError, SupplierTimeoutError } from "./errors.ts";
import type { SupplierAdapter } from "./supplier-adapter.ts";
import type { SupplierSessionManager } from "../session/session-manager.ts";
import type {
  SearchStreamEvent,
  SearchSupplierStatusEvent,
  SupplierSearchQuery,
  NormalizedSearchResult,
} from "../types.ts";

interface RunSupplierSearchOptions {
  adapter: SupplierAdapter;
  sessionManager: SupplierSessionManager;
  query: SupplierSearchQuery;
  signal: AbortSignal;
  emit: (event: SearchStreamEvent) => void;
  onAuthError?: () => void;
}

const createStatusEvent = (
  supplier: SupplierAdapter["id"],
  status: SearchSupplierStatusEvent["status"],
  details?: string,
): SearchSupplierStatusEvent => ({
  type: "supplier_status",
  supplier,
  status,
  details,
});

function isValidDate(value: string | null | undefined): boolean {
  return value === null || value === undefined || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

function isValidResult(result: NormalizedSearchResult, supplier: SupplierAdapter["id"]): boolean {
  if (result.supplier !== supplier) {
    return false;
  }
  if (
    typeof result.brand !== "string" ||
    typeof result.article !== "string" ||
    typeof result.title !== "string" ||
    !result.brand.trim() ||
    !result.article.trim() ||
    !result.title.trim()
  ) {
    return false;
  }
  if (!Number.isFinite(result.price) || result.price <= 0) {
    return false;
  }
  if (result.quantity !== undefined && result.quantity !== null &&
    (!Number.isFinite(result.quantity) || result.quantity < 0)) {
    return false;
  }
  if (!isValidDate(result.deliveryDate) || !isValidDate(result.deliveryDateTo)) {
    return false;
  }
  if (
    typeof result.deliveryDateApproximate !== "boolean" ||
    (result.isAnalog !== undefined && typeof result.isAnalog !== "boolean") ||
    (result.warehouse !== null && typeof result.warehouse !== "string") ||
    (result.warehouseFull !== undefined && result.warehouseFull !== null && typeof result.warehouseFull !== "string")
  ) {
    return false;
  }
  try {
    const link = new URL(result.link);
    return link.protocol === "http:" || link.protocol === "https:";
  } catch {
    return false;
  }
}

export async function runSupplierSearch({
  adapter,
  sessionManager,
  query,
  signal,
  emit,
  onAuthError,
}: RunSupplierSearchOptions): Promise<void> {
  if (signal.aborted) {
    return;
  }

  const operation = sessionManager.beginOperation(adapter.id, signal);
  emit(createStatusEvent(adapter.id, "searching"));
  if (operation.signal.aborted) {
    emit(createStatusEvent(adapter.id, "auth_error", "Supplier authorization is required"));
    operation.dispose();
    return;
  }

  const controller = new AbortController();
  const abortForwarder = () => controller.abort(operation.signal.reason);
  operation.signal.addEventListener("abort", abortForwarder, { once: true });

  const timeoutId = setTimeout(() => {
    controller.abort(new SupplierTimeoutError(`Timeout after ${adapter.timeoutMs}ms`));
  }, adapter.timeoutMs);
  let validResultCount = 0;
  let invalidResultCount = 0;

  try {
    const session = await adapter.ensureSession(sessionManager);

    if (!session.authorized) {
      throw new SupplierAuthError("Session is not authorized");
    }

    const context = {
      signal: controller.signal,
      timeoutMs: adapter.timeoutMs,
    };
    const onResult = (result: NormalizedSearchResult) => {
      if (!operation.isCurrent()) {
        return;
      }
      if (isValidResult(result, adapter.id)) {
        validResultCount += 1;
        emit({ type: "result", result });
      } else {
        invalidResultCount += 1;
      }
    };
    if ("mode" in query && query.mode === "analogs") {
      if (!adapter.searchAnalogs) {
        throw new SupplierIntegrationError("Supplier does not support analog search");
      }
      await adapter.searchAnalogs(query, context, onResult, sessionManager);
    } else {
      await adapter.search(query, context, onResult, sessionManager);
    }

    if (invalidResultCount > 0 && validResultCount === 0) {
      throw new SupplierIntegrationError("Supplier returned only invalid search results");
    }

    if (operation.isCurrent()) {
      emit(createStatusEvent(adapter.id, "completed"));
    } else if (!signal.aborted) {
      emit(createStatusEvent(adapter.id, "auth_error", "Supplier authorization is required"));
    }
  } catch (error) {
    if (signal.aborted) {
      return;
    }

    if (error instanceof SupplierSessionInvalidatedError || operation.signal.reason instanceof SupplierSessionInvalidatedError) {
      emit(createStatusEvent(adapter.id, "auth_error", "Supplier authorization is required"));
      return;
    }

    if (error instanceof SupplierAuthError) {
      onAuthError?.();
      emit(createStatusEvent(adapter.id, "auth_error", "Supplier authorization is required"));
      return;
    }

    if (error instanceof SupplierTimeoutError || controller.signal.reason instanceof SupplierTimeoutError) {
      emit(createStatusEvent(adapter.id, "timeout", "Supplier search timed out"));
      return;
    }

    const details = error instanceof SupplierIntegrationError && error.publicMessage
      ? error.publicMessage
      : "Supplier search failed";
    emit(createStatusEvent(adapter.id, "error", details));
  } finally {
    clearTimeout(timeoutId);
    operation.signal.removeEventListener("abort", abortForwarder);
    operation.dispose();
  }
}
