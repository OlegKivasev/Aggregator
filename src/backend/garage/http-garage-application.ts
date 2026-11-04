import type { NormalizedSearchResult, SearchStreamEvent, SupplierId, SupplierSearchQuery } from "../types.ts";
import { getGarageDatabasePath } from "../config.ts";
import { GarageApplicationService } from "./garage-application-service.ts";
import { SqliteGarageRepository } from "./sqlite-garage-repository.ts";
import { SupplierAuthError, SupplierIntegrationError, SupplierTimeoutError } from "../errors.ts";

export function createHttpGarageApplication(
  streamSearch: (query: SupplierSearchQuery, emit: (event: SearchStreamEvent) => void, signal: AbortSignal) => Promise<void>,
): GarageApplicationService {
  return new GarageApplicationService(new SqliteGarageRepository(getGarageDatabasePath()), {
    async findOffers(article: string, supplier: SupplierId, signal: AbortSignal) {
      const results: NormalizedSearchResult[] = [];
      let failed = false;
      let completed = false;
      try {
        await streamSearch({ article, suppliers: [supplier] }, (event) => {
          if (event.type === "result" && event.result.supplier === supplier) results.push(event.result);
          if (event.type === "supplier_status" && event.supplier === supplier) {
            completed = event.status === "completed";
            if (["auth_error", "timeout", "error"].includes(event.status)) failed = true;
          }
          if (event.type === "fatal_error") failed = true;
        }, signal);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof SupplierAuthError || error instanceof SupplierTimeoutError || error instanceof SupplierIntegrationError) failed = true;
        else throw error;
      }
      signal.throwIfAborted();
      return { results, failed: failed || !completed };
    },
  });
}
