import { SupplierAuthError, SupplierIntegrationError } from "../errors.ts";
import type { ApplicabilityApiKeyState, ApplicabilitySearchQuery, ApplicabilitySearchRequest, ApplicabilitySearchResult, ApplicabilityVehicle } from "./types.ts";

export interface ApplicabilityClient {
  search(query: ApplicabilitySearchQuery, signal: AbortSignal): Promise<ApplicabilityVehicle[]>;
}

export interface ApplicabilityApiKeyRepository {
  get(): string | null;
  set(apiKey: string): void;
  delete(): void;
  getFallbackKeyCount(): number;
  addFallbackKey(apiKey: string): void;
  deleteFallbackKey(index: number): void;
  isPersistent(): boolean;
}

export interface ApplicabilityCacheRepository {
  get(query: ApplicabilitySearchRequest): ApplicabilityVehicle[] | null;
  findBrands(sku: string): string[];
  set(query: ApplicabilitySearchRequest, results: ApplicabilityVehicle[]): void;
}

export class ApplicabilityApplicationService {
  private readonly client: ApplicabilityClient;
  private readonly apiKeyRepository: ApplicabilityApiKeyRepository;
  private readonly cacheRepository: ApplicabilityCacheRepository;

  constructor(client: ApplicabilityClient, apiKeyRepository: ApplicabilityApiKeyRepository, cacheRepository: ApplicabilityCacheRepository) {
    this.client = client;
    this.apiKeyRepository = apiKeyRepository;
    this.cacheRepository = cacheRepository;
  }

  async search(query: ApplicabilitySearchRequest, signal: AbortSignal): Promise<ApplicabilitySearchResult> {
    const cachedResults = this.cacheRepository.get(query);
    if (cachedResults) return { results: cachedResults, cacheHit: true };
    const apiKey = this.apiKeyRepository.get();
    if (!apiKey) throw new SupplierAuthError("PartsAPI key is not configured");
    const results = await this.client.search({ ...query, apiKey }, signal);
    this.cacheRepository.set(query, results);
    return { results, cacheHit: false };
  }

  getCachedBrands(sku: string): string[] {
    return this.cacheRepository.findBrands(sku);
  }

  getApiKeyState(): ApplicabilityApiKeyState {
    return {
      configured: this.apiKeyRepository.get() !== null,
      fallbackKeyCount: this.apiKeyRepository.getFallbackKeyCount(),
      persistent: this.apiKeyRepository.isPersistent(),
    };
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

  addFallbackApiKey(apiKey: string): ApplicabilityApiKeyState {
    if (!this.apiKeyRepository.isPersistent()) {
      throw new SupplierIntegrationError("PartsAPI key persistence is not configured", {
        publicMessage: "Защищённое хранение API-ключа не настроено.",
      });
    }
    this.apiKeyRepository.addFallbackKey(apiKey);
    return this.getApiKeyState();
  }

  deleteFallbackApiKey(index: number): ApplicabilityApiKeyState {
    this.apiKeyRepository.deleteFallbackKey(index);
    return this.getApiKeyState();
  }
}
