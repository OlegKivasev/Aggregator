import type { NormalizedSearchResult, SearchStreamEvent, SupplierId, SupplierSearchQuery } from "../types.ts";
import { getGarageDatabasePath } from "../config.ts";
import { GarageApplicationService } from "./garage-application-service.ts";
import { SqliteGarageRepository } from "./sqlite-garage-repository.ts";

export function createHttpGarageApplication(
  streamSearch: (query: SupplierSearchQuery, emit: (event: SearchStreamEvent) => void, signal: AbortSignal) => Promise<void>,
): GarageApplicationService {
  return new GarageApplicationService(new SqliteGarageRepository(getGarageDatabasePath()), {
    async findOffers(article: string, supplier: SupplierId, signal: AbortSignal) {
      const results: NormalizedSearchResult[] = [];
      let failed = false;
      await streamSearch({ article, suppliers: [supplier] }, (event) => {
        if (event.type === "result") results.push(event.result);
        if (event.type === "supplier_status" && ["auth_error", "timeout", "error"].includes(event.status)) failed = true;
      }, signal);
      return { results, failed };
    },
  });
}
