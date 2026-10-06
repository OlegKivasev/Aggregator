import type { ApplicabilitySearchQuery, ApplicabilityVehicle } from "./types.ts";

export interface ApplicabilityClient {
  search(query: ApplicabilitySearchQuery, signal: AbortSignal): Promise<ApplicabilityVehicle[]>;
}

export class ApplicabilityApplicationService {
  private readonly client: ApplicabilityClient;

  constructor(client: ApplicabilityClient) {
    this.client = client;
  }

  search(query: ApplicabilitySearchQuery, signal: AbortSignal): Promise<ApplicabilityVehicle[]> {
    return this.client.search(query, signal);
  }
}
