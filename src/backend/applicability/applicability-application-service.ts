import { SupplierAuthError, SupplierIntegrationError } from "../errors.ts";
import type { ApplicabilityApiKeyState, ApplicabilitySavedArticlesPage, ApplicabilitySavedArticlesQuery, ApplicabilitySearchQuery, ApplicabilitySearchRequest, ApplicabilitySearchResult, ApplicabilityVehicle } from "./types.ts";

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
  list(query: ApplicabilitySavedArticlesQuery): ApplicabilitySavedArticlesPage;
  delete(query: ApplicabilitySearchRequest): boolean;
}

export class ApplicabilityApplicationService {
  private readonly client: ApplicabilityClient;
  private readonly apiKeyRepository: ApplicabilityApiKeyRepository;
  private readonly cacheRepository: ApplicabilityCacheRepository;
  private readonly pendingWrites = new Map<string, Set<{ deleted: boolean }>>();

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
    const identity = this.cacheIdentity(query);
    const pending = { deleted: false };
    const writes = this.pendingWrites.get(identity) ?? new Set<{ deleted: boolean }>();
    writes.add(pending);
    this.pendingWrites.set(identity, writes);
    try {
      const results = await this.client.search({ ...query, apiKey }, signal);
      signal.throwIfAborted();
      if (pending.deleted) throw new SupplierIntegrationError("Applicability entry was deleted during search", {
        publicMessage: "OEM-артикул удалён из базы во время поиска. Повторите поиск, чтобы сохранить его снова.",
      });
      this.cacheRepository.set(query, results);
      return { results, cacheHit: false };
    } finally {
      writes.delete(pending);
      if (!writes.size) this.pendingWrites.delete(identity);
    }
  }

  private cacheIdentity(query: ApplicabilitySearchRequest): string {
    return JSON.stringify([query.sku.toLocaleUpperCase(), query.brand.toLocaleUpperCase()]);
  }

  listSavedArticles(query: ApplicabilitySavedArticlesQuery): ApplicabilitySavedArticlesPage {
    return this.cacheRepository.list(query);
  }

  getSavedArticle(query: ApplicabilitySearchRequest): ApplicabilityVehicle[] | null {
    return this.cacheRepository.get(query);
  }

  deleteSavedArticle(query: ApplicabilitySearchRequest): boolean {
    const deleted = this.cacheRepository.delete(query);
    this.pendingWrites.get(this.cacheIdentity(query))?.forEach((pending) => { pending.deleted = true; });
    return deleted;
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
