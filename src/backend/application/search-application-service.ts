import type { SupplierSessionManager } from "../session/session-manager.ts";
import { runSupplierSearch } from "../suppliers/run-supplier-search.ts";
import type { SupplierAdapter } from "../suppliers/supplier-adapter.ts";
import type { SearchQuery, SearchStreamEvent, SupplierId } from "../types.ts";

export function selectSupplierAdapters(adapters: SupplierAdapter[], suppliers?: SupplierId[]): SupplierAdapter[] {
  return suppliers ? adapters.filter((adapter) => suppliers.includes(adapter.id)) : adapters;
}

export class SearchApplicationService {
  private readonly adapters: SupplierAdapter[];
  private readonly sessionManager: SupplierSessionManager;
  private readonly disconnectSupplier: (supplier: SupplierId) => void;

  constructor(
    adapters: SupplierAdapter[],
    sessionManager: SupplierSessionManager,
    disconnectSupplier: (supplier: SupplierId) => void,
  ) {
    this.adapters = adapters;
    this.sessionManager = sessionManager;
    this.disconnectSupplier = disconnectSupplier;
  }

  async streamSearch(
    query: SearchQuery,
    emit: (event: SearchStreamEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const currentAdapters = selectSupplierAdapters(this.adapters, query.suppliers);

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
        }),
      ),
    );

    if (!signal.aborted) {
      emit({ type: "search_completed", article: query.article });
    }
  }
}
