import { SupplierAuthError, SupplierTimeoutError } from "./errors.ts";
import type { SupplierAdapter } from "./supplier-adapter.ts";
import type { SupplierSessionManager } from "../session/session-manager.ts";
import type {
  SearchStreamEvent,
  SearchSupplierStatusEvent,
  SearchQuery,
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

function isTimeoutLikeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|Timeout/i.test(message);
}

export async function runSupplierSearch({
  adapter,
  sessionManager,
  query,
  signal,
  emit,
  onAuthError,
}: RunSupplierSearchOptions): Promise<void> {
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
        emit({ type: "result", result });
      },
      sessionManager,
    );

    emit(createStatusEvent(adapter.id, "completed"));
  } catch (error) {
    if (error instanceof SupplierAuthError) {
      onAuthError?.();
      emit(createStatusEvent(adapter.id, "auth_error", error.message));
      return;
    }

    if (error instanceof SupplierTimeoutError || controller.signal.reason instanceof SupplierTimeoutError || isTimeoutLikeError(error)) {
      const timeoutMessage = error instanceof Error ? error.message : "Supplier timeout";
      emit(createStatusEvent(adapter.id, "timeout", timeoutMessage));
      return;
    }

    if (controller.signal.aborted && signal.aborted) {
      emit(createStatusEvent(adapter.id, "error", "Search was aborted"));
      return;
    }

    const message = error instanceof Error ? error.message : "Unknown supplier error";
    emit(createStatusEvent(adapter.id, "error", message));
  } finally {
    clearTimeout(timeoutId);
    signal.removeEventListener("abort", abortForwarder);
  }
}
