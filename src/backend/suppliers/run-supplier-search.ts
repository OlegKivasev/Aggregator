import { SupplierAuthError, SupplierTimeoutError } from "./errors.ts";
import type { SupplierAdapter } from "./supplier-adapter.ts";
import type { SupplierSessionManager } from "../session/session-manager.ts";
import type {
  SearchStreamEvent,
  SearchSupplierStatusEvent,
  SearchQuery,
  NormalizedSearchResult,
} from "../types.ts";

interface RunSupplierSearchOptions {
  adapter: SupplierAdapter;
  sessionManager: SupplierSessionManager;
  query: SearchQuery;
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
  if (!result.brand.trim() || !result.article.trim() || !result.title.trim()) {
    return false;
  }
  if (!Number.isFinite(result.price) || result.price <= 0) {
    return false;
  }
  if (!isValidDate(result.deliveryDate) || !isValidDate(result.deliveryDateTo)) {
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

  emit(createStatusEvent(adapter.id, "searching"));

  const controller = new AbortController();
  const abortForwarder = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abortForwarder, { once: true });

  const timeoutId = setTimeout(() => {
    controller.abort(new SupplierTimeoutError(`Timeout after ${adapter.timeoutMs}ms`));
  }, adapter.timeoutMs);

  try {
    const session = await adapter.ensureSession(sessionManager);

    if (!session.authorized) {
      throw new SupplierAuthError("Session is not authorized");
    }

    await adapter.search(
      query,
      {
        signal: controller.signal,
        timeoutMs: adapter.timeoutMs,
      },
      (result) => {
        if (isValidResult(result, adapter.id)) {
          emit({ type: "result", result });
        }
      },
      sessionManager,
    );

    if (!signal.aborted) {
      emit(createStatusEvent(adapter.id, "completed"));
    }
  } catch (error) {
    if (signal.aborted) {
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

    emit(createStatusEvent(adapter.id, "error", "Supplier search failed"));
  } finally {
    clearTimeout(timeoutId);
    signal.removeEventListener("abort", abortForwarder);
  }
}
