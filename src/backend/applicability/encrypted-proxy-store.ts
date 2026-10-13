import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { SupplierIntegrationError } from "../errors.ts";
import { writeJsonStateFileAtomic } from "../session/state-file.ts";
import { parsePartsApiProxyConfig, PartsApiProxyValidationError, type PartsApiProxy, type PartsApiProxyConfig, type PartsApiProxyImportResult, type PartsApiProxyState, type PartsApiUsageCounters } from "./partsapi-proxy-config.ts";

const authenticatedContext = Buffer.from("autoservice-aggregator:partsapi-proxies:v1");
const usageWindowMs = 24 * 60 * 60 * 1000;
const maximumUsageCount = 1_000_000_000;
const proxyIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function createUsageCounters(): PartsApiUsageCounters {
  return { requestCount: 0, dataResponseCount: 0, emptyResponseCount: 0, failedRequestCount: 0 };
}

function cloneUsageCounters(value: PartsApiUsageCounters): PartsApiUsageCounters {
  return { ...value };
}

function hasUsageCounters(value: PartsApiUsageCounters): boolean {
  return value.requestCount > 0 || value.dataResponseCount > 0 || value.emptyResponseCount > 0 || value.failedRequestCount > 0;
}

function incrementUsageCounter(value: PartsApiUsageCounters, field: keyof PartsApiUsageCounters): void {
  if (value[field] >= maximumUsageCount) throw new SupplierIntegrationError("PartsAPI usage counter is full", { publicMessage: "Счётчик запросов достиг технического предела." });
  value[field] += 1;
}

function parseUsageCounters(value: unknown): PartsApiUsageCounters {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid usage counters");
  const counters = value as Record<string, unknown>;
  const result = {
    requestCount: counters.requestCount,
    dataResponseCount: counters.dataResponseCount,
    emptyResponseCount: counters.emptyResponseCount,
    failedRequestCount: counters.failedRequestCount,
  };
  if (Object.values(result).some((count) => typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > maximumUsageCount)) throw new Error("Invalid usage counter value");
  const parsed = result as PartsApiUsageCounters;
  if (parsed.dataResponseCount + parsed.emptyResponseCount + parsed.failedRequestCount > parsed.requestCount) throw new Error("Invalid usage outcome total");
  return parsed;
}

function finishInterruptedUsage(value: PartsApiUsageCounters): boolean {
  const pending = value.requestCount - value.dataResponseCount - value.emptyResponseCount - value.failedRequestCount;
  if (pending === 0) return false;
  // No request from the previous process can complete after startup.
  value.failedRequestCount += pending;
  return true;
}

export interface PartsApiRouteSelection {
  id: string | null;
  revision: number;
  proxy: PartsApiProxy | null;
}

export class EncryptedPartsApiProxyStore {
  private proxies: PartsApiProxy[] = [];
  private activeRouteId: string | null = null;
  private revision = 0;
  private readonly limitedRoutes = new Set<string | null>();
  private lastSwitchReason: PartsApiProxyState["lastSwitchReason"] = null;
  private readonly filePath: string;
  private readonly encryptionKey: Buffer | null;
  private readonly now: () => number;
  private usageWindowStartedAt: number | null = null;
  private apiKeyUsage: PartsApiUsageCounters = createUsageCounters();
  private directUsage: PartsApiUsageCounters = createUsageCounters();
  private readonly proxyUsage = new Map<string, PartsApiUsageCounters>();

  constructor(filePath: string, encryptionKey: Buffer | null, now: () => number = Date.now) {
    this.filePath = filePath;
    this.encryptionKey = encryptionKey;
    this.now = now;
    this.load();
  }

  getState(): PartsApiProxyState {
    this.ensureUsageWindow();
    const resetAt = this.usageWindowStartedAt === null ? null : this.usageWindowStartedAt + usageWindowMs;
    return {
      persistent: this.encryptionKey !== null,
      activeRouteId: this.activeRouteId,
      directLimited: this.limitedRoutes.has(null),
      lastSwitchReason: this.lastSwitchReason,
      usage: {
        ...cloneUsageCounters(this.apiKeyUsage),
        windowStartedAt: this.usageWindowStartedAt,
        resetAt,
        secondsUntilReset: resetAt === null ? null : Math.max(1, Math.ceil((resetAt - this.now()) / 1000)),
      },
      directUsage: cloneUsageCounters(this.directUsage),
      proxies: this.proxies.map(({ id, protocol, host, port }) => ({
        id, protocol, host, port, limited: this.limitedRoutes.has(id), usage: cloneUsageCounters(this.proxyUsage.get(id) ?? createUsageCounters()),
      })),
    };
  }

  getSelection(): PartsApiRouteSelection {
    this.ensureUsageWindow();
    return { id: this.activeRouteId, revision: this.revision, proxy: this.proxies.find(({ id }) => id === this.activeRouteId) ?? null };
  }

  recordAttempt(routeId: string | null): number {
    this.ensureUsageWindow();
    const previousWindowStartedAt = this.usageWindowStartedAt;
    const previousApiKeyUsage = cloneUsageCounters(this.apiKeyUsage);
    const previousDirectUsage = cloneUsageCounters(this.directUsage);
    const previousProxyUsage = routeId === null ? undefined : this.proxyUsage.get(routeId);
    const now = this.now();
    if (this.usageWindowStartedAt === null) this.usageWindowStartedAt = now;
    try {
      incrementUsageCounter(this.apiKeyUsage, "requestCount");
      const routeUsage = routeId === null ? this.directUsage : cloneUsageCounters(previousProxyUsage ?? createUsageCounters());
      incrementUsageCounter(routeUsage, "requestCount");
      if (routeId !== null) this.proxyUsage.set(routeId, routeUsage);
      this.persistIfConfigured();
    } catch (error) {
      this.usageWindowStartedAt = previousWindowStartedAt;
      this.apiKeyUsage = previousApiKeyUsage;
      this.directUsage = previousDirectUsage;
      if (routeId !== null) {
        if (previousProxyUsage) this.proxyUsage.set(routeId, previousProxyUsage);
        else this.proxyUsage.delete(routeId);
      }
      throw error;
    }
    return this.usageWindowStartedAt;
  }

  recordOutcome(routeId: string | null, outcome: "data" | "empty" | "failed", attemptWindowStartedAt: number): void {
    this.ensureUsageWindow();
    if (this.usageWindowStartedAt !== attemptWindowStartedAt) return;
    const field = outcome === "data" ? "dataResponseCount" : outcome === "empty" ? "emptyResponseCount" : "failedRequestCount";
    incrementUsageCounter(this.apiKeyUsage, field);
    if (routeId === null) incrementUsageCounter(this.directUsage, field);
    else if (this.proxies.some((proxy) => proxy.id === routeId)) incrementUsageCounter(this.getProxyUsage(routeId), field);
    this.persistIfConfigured();
  }

  add(config: PartsApiProxyConfig): PartsApiProxyState {
    const parsed = parsePartsApiProxyConfig(config);
    if (this.proxies.some(({ host, port }) => host === parsed.host && port === parsed.port)) {
      throw new SupplierIntegrationError("PartsAPI proxy already exists", { publicMessage: "Прокси с таким адресом и портом уже добавлен." });
    }
    this.commit([...this.proxies, { ...parsed, id: randomUUID() }], this.activeRouteId);
    return this.getState();
  }

  import(configs: PartsApiProxyConfig[]): PartsApiProxyImportResult {
    if (!configs.length) throw new PartsApiProxyValidationError("Файл не содержит прокси.");
    const parsed = configs.map(parsePartsApiProxyConfig);
    const addresses = new Set(this.proxies.map(({ host, port }) => `${host}:${port}`));
    const additions: PartsApiProxy[] = [];
    for (const config of parsed) {
      const address = `${config.host}:${config.port}`;
      if (addresses.has(address)) continue;
      addresses.add(address);
      additions.push({ ...config, id: randomUUID() });
    }
    if (additions.length) this.commit([...this.proxies, ...additions], this.activeRouteId);
    return { ...this.getState(), importedCount: additions.length, duplicateCount: parsed.length - additions.length };
  }

  select(routeId: string | null): PartsApiProxyState {
    if (routeId !== null && !this.proxies.some(({ id }) => id === routeId)) throw new PartsApiProxyValidationError();
    const wasLimited = this.limitedRoutes.has(routeId);
    const previousReason = this.lastSwitchReason;
    this.limitedRoutes.delete(routeId);
    this.lastSwitchReason = "manual";
    try {
      this.commit(this.proxies, routeId);
    } catch (error) {
      if (wasLimited) this.limitedRoutes.add(routeId);
      this.lastSwitchReason = previousReason;
      throw error;
    }
    this.revision += 1;
    return this.getState();
  }

  delete(id: string): PartsApiProxyState {
    if (!proxyIdPattern.test(id) || !this.proxies.some((proxy) => proxy.id === id)) throw new PartsApiProxyValidationError();
    // Require an explicit new route before deleting the active proxy; never silently bypass it.
    if (this.activeRouteId === id) throw new SupplierIntegrationError("Active PartsAPI proxy cannot be deleted", { publicMessage: "Сначала выберите другое соединение, затем удалите этот прокси." });
    this.commit(this.proxies.filter((proxy) => proxy.id !== id), this.activeRouteId);
    this.limitedRoutes.delete(id);
    this.proxyUsage.delete(id);
    return this.getState();
  }

  advanceAfterIpLimit(failed: PartsApiRouteSelection, attempted: Set<string | null>): PartsApiRouteSelection | null {
    this.ensureUsageWindow();
    if (failed.revision !== this.revision) {
      // A concurrent search or manual choice already changed the route. Do not overwrite it.
      return attempted.has(this.activeRouteId) ? null : this.getSelection();
    }
    this.limitedRoutes.add(failed.id);
    const start = this.proxies.findIndex(({ id }) => id === failed.id) + 1;
    const ordered = [...this.proxies.slice(start), ...this.proxies.slice(0, start)];
    const next = ordered.find(({ id }) => !this.limitedRoutes.has(id) && !attempted.has(id));
    if (!next) {
      this.persistIfConfigured();
      return null;
    }
    const previousReason = this.lastSwitchReason;
    this.lastSwitchReason = "ip-limit";
    try {
      this.commit(this.proxies, next.id);
    } catch (error) {
      this.lastSwitchReason = previousReason;
      throw error;
    }
    this.revision += 1;
    return this.getSelection();
  }

  recordSuccess(selection: PartsApiRouteSelection): void {
    this.ensureUsageWindow();
    if (selection.revision === this.revision && this.limitedRoutes.delete(selection.id)) this.persistIfConfigured();
  }

  private commit(proxies: PartsApiProxy[], activeRouteId: string | null): void {
    if (!this.encryptionKey) throw new SupplierIntegrationError("PartsAPI proxy persistence is not configured", { publicMessage: "Защищённое хранение прокси не настроено." });
    const previousProxies = this.proxies;
    const previousActiveRouteId = this.activeRouteId;
    this.proxies = proxies;
    this.activeRouteId = activeRouteId;
    try {
      this.persistIfConfigured();
    } catch (error) {
      this.proxies = previousProxies;
      this.activeRouteId = previousActiveRouteId;
      throw error;
    }
  }

  private ensureUsageWindow(): void {
    if (this.usageWindowStartedAt === null || this.now() < this.usageWindowStartedAt + usageWindowMs) return;
    const previous = {
      startedAt: this.usageWindowStartedAt, apiKeyUsage: this.apiKeyUsage, directUsage: this.directUsage,
      proxyUsage: new Map(this.proxyUsage), limitedRoutes: new Set(this.limitedRoutes), lastSwitchReason: this.lastSwitchReason,
    };
    // Keep the persisted daily boundary even after idle days or a process restart.
    this.usageWindowStartedAt += Math.floor((this.now() - this.usageWindowStartedAt) / usageWindowMs) * usageWindowMs;
    this.apiKeyUsage = createUsageCounters();
    this.directUsage = createUsageCounters();
    this.proxyUsage.clear();
    this.limitedRoutes.clear();
    this.lastSwitchReason = null;
    try {
      this.persistIfConfigured();
    } catch (error) {
      this.usageWindowStartedAt = previous.startedAt;
      this.apiKeyUsage = previous.apiKeyUsage;
      this.directUsage = previous.directUsage;
      for (const [id, counters] of previous.proxyUsage) this.proxyUsage.set(id, counters);
      for (const id of previous.limitedRoutes) this.limitedRoutes.add(id);
      this.lastSwitchReason = previous.lastSwitchReason;
      throw error;
    }
    this.revision += 1;
  }

  private getProxyUsage(id: string): PartsApiUsageCounters {
    const existing = this.proxyUsage.get(id);
    if (existing) return existing;
    const created = createUsageCounters();
    this.proxyUsage.set(id, created);
    return created;
  }

  private persistIfConfigured(): void {
    if (!this.encryptionKey) return;
    const persistedProxyUsage = Object.fromEntries([...this.proxyUsage.entries()]
      .filter(([id]) => this.proxies.some((proxy) => proxy.id === id))
      .map(([id, usage]) => [id, usage]));
    const hasUsage = this.usageWindowStartedAt !== null
      || hasUsageCounters(this.apiKeyUsage)
      || hasUsageCounters(this.directUsage)
      || Object.keys(persistedProxyUsage).length > 0;
    if (!this.proxies.length && !hasUsage) {
      rmSync(this.filePath, { force: true });
      return;
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    cipher.setAAD(authenticatedContext);
    const payload = JSON.stringify({
      version: 2,
      proxies: this.proxies,
      activeRouteId: this.activeRouteId,
      limitedRoutes: [...this.limitedRoutes].filter((id) => id === null || this.proxies.some((proxy) => proxy.id === id)),
      lastSwitchReason: this.lastSwitchReason,
      usageWindowStartedAt: this.usageWindowStartedAt,
      apiKeyUsage: this.apiKeyUsage,
      directUsage: this.directUsage,
      proxyUsage: persistedProxyUsage,
    });
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    writeJsonStateFileAtomic(this.filePath, {
      version: 1, algorithm: "aes-256-gcm", iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"), authTag: cipher.getAuthTag().toString("base64"),
    });
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    if (!this.encryptionKey) throw new Error("SUPPLIER_CREDENTIALS_ENCRYPTION_KEY is required to read PartsAPI proxies");
    try {
      const envelope: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error("Invalid proxy envelope");
      const { version, algorithm, iv, ciphertext, authTag } = envelope as Record<string, unknown>;
      const decode = (value: unknown): Buffer => {
        if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4) throw new Error("Invalid proxy encryption field");
        return Buffer.from(value, "base64");
      };
      const nonce = decode(iv);
      const tag = decode(authTag);
      if (version !== 1 || algorithm !== "aes-256-gcm" || nonce.length !== 12 || tag.length !== 16) throw new Error("Invalid proxy encryption parameters");
      const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, nonce);
      decipher.setAAD(authenticatedContext);
      decipher.setAuthTag(tag);
      const payload: unknown = JSON.parse(Buffer.concat([decipher.update(decode(ciphertext)), decipher.final()]).toString("utf8"));
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid proxy payload");
      const data = payload as Record<string, unknown>;
      if ((data.version !== 1 && data.version !== 2) || !Array.isArray(data.proxies)) throw new Error("Invalid proxy list");
      const proxies = data.proxies.map((value: unknown) => {
        const config = parsePartsApiProxyConfig(value);
        const id = (value as Record<string, unknown>).id;
        if (typeof id !== "string" || !proxyIdPattern.test(id)) throw new Error("Invalid proxy ID");
        return { ...config, id };
      });
      if (new Set(proxies.map(({ id }) => id)).size !== proxies.length
        || new Set(proxies.map(({ host, port }) => `${host}:${port}`)).size !== proxies.length
        || (data.activeRouteId !== null && !proxies.some(({ id }) => id === data.activeRouteId))) throw new Error("Invalid proxy selection");
      this.proxies = proxies;
      this.activeRouteId = data.activeRouteId as string | null;
      if (data.version === 2) {
        if (data.usageWindowStartedAt !== null && (typeof data.usageWindowStartedAt !== "number" || !Number.isSafeInteger(data.usageWindowStartedAt) || data.usageWindowStartedAt < 0)) throw new Error("Invalid usage window");
        this.usageWindowStartedAt = data.usageWindowStartedAt as number | null;
        this.apiKeyUsage = parseUsageCounters(data.apiKeyUsage);
        this.directUsage = parseUsageCounters(data.directUsage);
        if (!data.proxyUsage || typeof data.proxyUsage !== "object" || Array.isArray(data.proxyUsage)) throw new Error("Invalid proxy usage");
        for (const [id, value] of Object.entries(data.proxyUsage)) {
          if (!proxies.some((proxy) => proxy.id === id)) throw new Error("Invalid proxy usage ID");
          this.proxyUsage.set(id, parseUsageCounters(value));
        }
        if (!Array.isArray(data.limitedRoutes) || data.limitedRoutes.length > proxies.length + 1
          || data.limitedRoutes.some((id: unknown) => id !== null && !proxies.some((proxy) => proxy.id === id))
          || ![null, "manual", "ip-limit"].includes(data.lastSwitchReason as PartsApiProxyState["lastSwitchReason"])) throw new Error("Invalid proxy limit state");
        for (const id of data.limitedRoutes) this.limitedRoutes.add(id as string | null);
        this.lastSwitchReason = data.lastSwitchReason as PartsApiProxyState["lastSwitchReason"];
        const interrupted = [this.apiKeyUsage, this.directUsage, ...this.proxyUsage.values()]
          .map(finishInterruptedUsage).some(Boolean);
        this.ensureUsageWindow();
        if (interrupted) this.persistIfConfigured();
      }
    } catch (error) {
      throw new Error("Stored PartsAPI proxies could not be decrypted or validated", { cause: error });
    }
  }
}
