import type { SupplierSessionManager } from "../session/session-manager.ts";
import { runSupplierSearch, type SupplierSearchOperationalError } from "../suppliers/run-supplier-search.ts";
import type { SupplierAdapter } from "../suppliers/supplier-adapter.ts";
import type { SearchStreamEvent, SupplierId, SupplierSearchQuery } from "../types.ts";

export function selectSupplierAdapters(adapters: SupplierAdapter[], suppliers?: SupplierId[]): SupplierAdapter[] {
  return suppliers ? adapters.filter((adapter) => suppliers.includes(adapter.id)) : adapters;
}

export class SearchApplicationService {
  private readonly adapters: SupplierAdapter[];
  private readonly sessionManager: SupplierSessionManager;
  private readonly disconnectSupplier: (supplier: SupplierId) => void;
  private readonly reportError: (event: SupplierSearchOperationalError) => void;

  constructor(
    adapters: SupplierAdapter[],
    sessionManager: SupplierSessionManager,
    disconnectSupplier: (supplier: SupplierId) => void,
    reportError: (event: SupplierSearchOperationalError) => void = ({ supplier, category, diagnosticCode }) => {
      if (diagnosticCode) {
        console.error(`[aggregator] search-${supplier} failed (${category}) [${diagnosticCode}]`);
      }
    },
  ) {
    this.adapters = adapters;
    this.sessionManager = sessionManager;
    this.disconnectSupplier = disconnectSupplier;
    this.reportError = reportError;
  }

  async streamSearch(
    query: SupplierSearchQuery,
    emit: (event: SearchStreamEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const selectedAdapters = selectSupplierAdapters(this.adapters, query.suppliers);
    const currentAdapters = "mode" in query && query.mode === "analogs"
      ? selectedAdapters.filter((adapter) => adapter.searchAnalogs)
      : selectedAdapters;

    emit({
      type: "search_started",
      article: query.article,
      suppliers: currentAdapters.map((adapter) => adapter.id),
    });

    await Promise.all(
      currentAdapters.map((adapter) =>
        runSupplierSearch({
          adapter,
          sessionManager: this.sessionManager,
          query,
          signal,
          emit,
          onAuthError: () => this.disconnectSupplier(adapter.id),
          reportError: this.reportError,
        }),
      ),
    );

    if (!signal.aborted) {
      emit({ type: "search_completed", article: query.article });
    }
  }
}
