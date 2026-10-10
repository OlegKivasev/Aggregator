import { SupplierAuthError, SupplierIntegrationError } from "../errors.ts";
import { createBoundedAbortSignal } from "../abort.ts";
import { PartsApiKeyError } from "./partsapi-key-error.ts";
import type { ApplicabilityApiKeyState, ApplicabilitySavedArticlesPage, ApplicabilitySavedArticlesQuery, ApplicabilitySearchQuery, ApplicabilitySearchRequest, ApplicabilitySearchResult, ApplicabilityVehicle } from "./types.ts";

export interface ApplicabilityClient {
  search(query: ApplicabilitySearchQuery, signal: AbortSignal): Promise<ApplicabilityVehicle[]>;
}

export interface ApplicabilityApiKeyRepository {
  getActiveKey(): string | null;
  getState(): ApplicabilityApiKeyState;
  markLimited(apiKey: string): void;
  recordRequest(apiKey: string): void;
  selectActiveKey(index: number): void;
  set(apiKey: string): void;
  delete(): void;
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
    const identity = this.cacheIdentity(query);
    const pending = { deleted: false };
    const writes = this.pendingWrites.get(identity) ?? new Set<{ deleted: boolean }>();
    writes.add(pending);
    this.pendingWrites.set(identity, writes);
    const boundedSignal = createBoundedAbortSignal(signal, 30_000, "PartsAPI key rotation timed out");
    try {
      const results = await this.searchWithAvailableKey(query, boundedSignal.signal);
      boundedSignal.signal.throwIfAborted();
      if (pending.deleted) throw new SupplierIntegrationError("Applicability entry was deleted during search", {
        publicMessage: "OEM-артикул удалён из базы во время поиска. Повторите поиск, чтобы сохранить его снова.",
      });
      this.cacheRepository.set(query, results);
      return { results, cacheHit: false };
    } finally {
      boundedSignal.dispose();
      writes.delete(pending);
      if (!writes.size) this.pendingWrites.delete(identity);
    }
  }

  private async searchWithAvailableKey(query: ApplicabilitySearchRequest, signal: AbortSignal): Promise<ApplicabilityVehicle[]> {
    const attemptedKeys = new Set<string>();
    let lastLimitError: PartsApiKeyError | null = null;
    // Snapshot the queue size so edits to settings cannot extend a running search indefinitely.
    const maximumAttempts = this.apiKeyRepository.getState().fallbackKeyCount + 1;
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      signal.throwIfAborted();
      const apiKey = this.apiKeyRepository.getActiveKey();
      if (!apiKey || attemptedKeys.has(apiKey)) {
        if (lastLimitError) throw lastLimitError;
        if (this.apiKeyRepository.getState().configured) throw new PartsApiKeyError(null, true);
        throw new SupplierAuthError("PartsAPI key is not configured");
      }
      attemptedKeys.add(apiKey);
      this.apiKeyRepository.recordRequest(apiKey);
      try {
        const results = await this.client.search({ ...query, apiKey }, signal);
        signal.throwIfAborted();
        return results;
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof PartsApiKeyError) || !error.limitExceeded) throw error;
        this.apiKeyRepository.markLimited(apiKey);
        lastLimitError = error;
      }
    }
    throw lastLimitError ?? new PartsApiKeyError(null, true);
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
    return this.apiKeyRepository.getState();
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

  selectActiveApiKey(index: number): ApplicabilityApiKeyState {
    this.apiKeyRepository.selectActiveKey(index);
    return this.getApiKeyState();
  }
}
