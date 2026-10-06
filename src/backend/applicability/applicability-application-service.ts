import { SupplierAuthError, SupplierIntegrationError } from "../errors.ts";
import type { ApplicabilityApiKeyState, ApplicabilitySearchQuery, ApplicabilitySearchRequest, ApplicabilityVehicle } from "./types.ts";

export interface ApplicabilityClient {
  search(query: ApplicabilitySearchQuery, signal: AbortSignal): Promise<ApplicabilityVehicle[]>;
}

export interface ApplicabilityApiKeyRepository {
  get(): string | null;
  set(apiKey: string): void;
  delete(): void;
  isPersistent(): boolean;
}

export class ApplicabilityApplicationService {
  private readonly client: ApplicabilityClient;
  private readonly apiKeyRepository: ApplicabilityApiKeyRepository;

  constructor(client: ApplicabilityClient, apiKeyRepository: ApplicabilityApiKeyRepository) {
    this.client = client;
    this.apiKeyRepository = apiKeyRepository;
  }

  search(query: ApplicabilitySearchRequest, signal: AbortSignal): Promise<ApplicabilityVehicle[]> {
    const apiKey = this.apiKeyRepository.get();
    if (!apiKey) throw new SupplierAuthError("PartsAPI key is not configured");
    return this.client.search({ ...query, apiKey }, signal);
  }

  getApiKeyState(): ApplicabilityApiKeyState {
    return { configured: this.apiKeyRepository.get() !== null, persistent: this.apiKeyRepository.isPersistent() };
  }

  saveApiKey(apiKey: string): ApplicabilityApiKeyState {
    if (!this.apiKeyRepository.isPersistent()) {
      throw new SupplierIntegrationError("PartsAPI key persistence is not configured", {
        publicMessage: "Защищённое хранение API-ключа не настроено.",
      });
    }
    this.apiKeyRepository.set(apiKey);
    return this.getApiKeyState();
  }

  deleteApiKey(): ApplicabilityApiKeyState {
    this.apiKeyRepository.delete();
    return this.getApiKeyState();
  }
}
