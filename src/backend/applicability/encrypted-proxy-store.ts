import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { SupplierIntegrationError } from "../errors.ts";
import { writeJsonStateFileAtomic } from "../session/state-file.ts";
import { parsePartsApiProxyConfig, PartsApiProxyValidationError, type PartsApiProxy, type PartsApiProxyConfig, type PartsApiProxyImportResult, type PartsApiProxyState, type PartsApiUsageCounters, type PartsApiUsageState } from "./partsapi-proxy-config.ts";

const authenticatedContext = Buffer.from("autoservice-aggregator:partsapi-proxies:v1");
const usageWindowMs = 24 * 60 * 60 * 1000;
const maximumUsageCount = 1_000_000_000;
const proxyIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function createUsageCounters(): PartsApiUsageCounters {
  return { requestCount: 0, dataResponseCount: 0, emptyResponseCount: 0, failedRequestCount: 0 };
}

interface RouteUsage extends PartsApiUsageCounters {
  windowStartedAt: number | null;
}

function createRouteUsage(): RouteUsage {
  return { ...createUsageCounters(), windowStartedAt: null };
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
  private directUsage: RouteUsage = createRouteUsage();
  private readonly proxyUsage = new Map<string, RouteUsage>();
  private readonly usageGenerations = new Map<string | null, number>();

  constructor(filePath: string, encryptionKey: Buffer | null, now: () => number = Date.now) {
    this.filePath = filePath;
    this.encryptionKey = encryptionKey;
    this.now = now;
    this.load();
  }

  getState(): PartsApiProxyState {
    this.ensureUsageWindow();
    const total = createUsageCounters();
    for (const usage of [this.directUsage, ...this.proxyUsage.values()]) {
      for (const field of Object.keys(total) as (keyof PartsApiUsageCounters)[]) total[field] += usage[field];
    }
    return {
      persistent: this.encryptionKey !== null,
      activeRouteId: this.activeRouteId,
      directLimited: this.limitedRoutes.has(null),
      lastSwitchReason: this.lastSwitchReason,
      usage: total,
      directUsage: this.describeUsage(this.directUsage),
      proxies: this.proxies.map(({ id, protocol, host, port }) => ({
        id, protocol, host, port, limited: this.limitedRoutes.has(id), usage: this.describeUsage(this.proxyUsage.get(id) ?? createRouteUsage()),
      })),
    };
  }

  getSelection(): PartsApiRouteSelection {
    this.ensureUsageWindow();
    return { id: this.activeRouteId, revision: this.revision, proxy: this.proxies.find(({ id }) => id === this.activeRouteId) ?? null };
  }

  recordAttempt(routeId: string | null): number {
    this.ensureUsageWindow();
    this.validateRoute(routeId);
    const previousUsage = routeId === null ? this.directUsage : this.proxyUsage.get(routeId);
    const routeUsage = { ...(previousUsage ?? createRouteUsage()) };
    try {
      incrementUsageCounter(routeUsage, "requestCount");
      this.setRouteUsage(routeId, routeUsage);
      this.persistIfConfigured();
    } catch (error) {
      this.setRouteUsage(routeId, previousUsage ?? createRouteUsage());
      throw error;
    }
    return this.usageGenerations.get(routeId) ?? 0;
  }

  recordOutcome(routeId: string | null, outcome: "data" | "empty" | "failed", attemptGeneration: number): void {
    this.ensureUsageWindow();
    if ((this.usageGenerations.get(routeId) ?? 0) !== attemptGeneration
      || (routeId !== null && !this.proxies.some((proxy) => proxy.id === routeId))) return;
    const previousUsage = routeId === null ? this.directUsage : this.proxyUsage.get(routeId);
    if (!previousUsage) return;
    const routeUsage = { ...previousUsage };
    const field = outcome === "data" ? "dataResponseCount" : outcome === "empty" ? "emptyResponseCount" : "failedRequestCount";
    incrementUsageCounter(routeUsage, field);
    if (outcome !== "failed" && routeUsage.windowStartedAt === null) routeUsage.windowStartedAt = this.now();
    this.setRouteUsage(routeId, routeUsage);
    try {
      this.persistIfConfigured();
    } catch (error) {
      this.setRouteUsage(routeId, previousUsage);
      throw error;
    }
  }

  resetUsage(routeId: string | null): PartsApiProxyState {
    this.validateRoute(routeId);
    this.resetRoutes([routeId]);
    return this.getState();
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
    const expired: (string | null)[] = [];
    const now = this.now();
    for (const [id, usage] of [[null, this.directUsage] as const, ...this.proxyUsage.entries()]) {
      if (usage.windowStartedAt !== null && now >= usage.windowStartedAt + usageWindowMs) expired.push(id);
    }
    if (expired.length) this.resetRoutes(expired);
  }

  private resetRoutes(ids: (string | null)[]): void {
    const previousDirectUsage = this.directUsage;
    const previousProxyUsage = new Map(this.proxyUsage);
    const previousLimits = new Set(this.limitedRoutes);
    for (const id of ids) {
      this.setRouteUsage(id, createRouteUsage());
      this.limitedRoutes.delete(id);
    }
    try {
      this.persistIfConfigured();
    } catch (error) {
      this.directUsage = previousDirectUsage;
      this.proxyUsage.clear();
      for (const [id, counters] of previousProxyUsage) this.proxyUsage.set(id, counters);
      this.limitedRoutes.clear();
      for (const id of previousLimits) this.limitedRoutes.add(id);
      throw error;
    }
    for (const id of ids) this.usageGenerations.set(id, (this.usageGenerations.get(id) ?? 0) + 1);
    this.revision += 1;
  }

  private validateRoute(id: string | null): void {
    if (id !== null && !this.proxies.some((proxy) => proxy.id === id)) throw new PartsApiProxyValidationError();
  }

  private setRouteUsage(id: string | null, usage: RouteUsage): void {
    if (id === null) this.directUsage = usage;
    else this.proxyUsage.set(id, usage);
  }

  private describeUsage(usage: RouteUsage): PartsApiUsageState {
    const resetAt = usage.windowStartedAt === null ? null : usage.windowStartedAt + usageWindowMs;
    return { ...usage, resetAt, secondsUntilReset: resetAt === null ? null : Math.max(0, Math.ceil((resetAt - this.now()) / 1000)) };
  }

  private persistIfConfigured(): void {
    if (!this.encryptionKey) return;
    const persistedProxyUsage = Object.fromEntries([...this.proxyUsage.entries()]
      .filter(([id]) => this.proxies.some((proxy) => proxy.id === id))
      .map(([id, usage]) => [id, usage]));
    const hasUsage = this.directUsage.windowStartedAt !== null
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
      version: 3,
      proxies: this.proxies,
      activeRouteId: this.activeRouteId,
      limitedRoutes: [...this.limitedRoutes].filter((id) => id === null || this.proxies.some((proxy) => proxy.id === id)),
      lastSwitchReason: this.lastSwitchReason,
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
      if (![1, 2, 3].includes(data.version as number) || !Array.isArray(data.proxies)) throw new Error("Invalid proxy list");
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
      if (data.version === 2 || data.version === 3) {
        const parseRouteUsage = (value: unknown): RouteUsage => {
          const counters = parseUsageCounters(value);
          // Version 2 persisted one shared boundary. Preserve it only for used routes.
          const startedAt = data.version === 2 ? data.usageWindowStartedAt : (value as Record<string, unknown>).windowStartedAt;
          if (startedAt !== null && (typeof startedAt !== "number" || !Number.isSafeInteger(startedAt) || startedAt < 0
            || !Number.isSafeInteger(startedAt + usageWindowMs))) throw new Error("Invalid usage window");
          return { ...counters, windowStartedAt: hasUsageCounters(counters) ? startedAt as number | null : null };
        };
        this.directUsage = parseRouteUsage(data.directUsage);
        if (!data.proxyUsage || typeof data.proxyUsage !== "object" || Array.isArray(data.proxyUsage)) throw new Error("Invalid proxy usage");
        for (const [id, value] of Object.entries(data.proxyUsage)) {
          if (!proxies.some((proxy) => proxy.id === id)) throw new Error("Invalid proxy usage ID");
          this.proxyUsage.set(id, parseRouteUsage(value));
        }
        if (!Array.isArray(data.limitedRoutes) || data.limitedRoutes.length > proxies.length + 1
          || data.limitedRoutes.some((id: unknown) => id !== null && !proxies.some((proxy) => proxy.id === id))
          || ![null, "manual", "ip-limit"].includes(data.lastSwitchReason as PartsApiProxyState["lastSwitchReason"])) throw new Error("Invalid proxy limit state");
        for (const id of data.limitedRoutes) this.limitedRoutes.add(id as string | null);
        this.lastSwitchReason = data.lastSwitchReason as PartsApiProxyState["lastSwitchReason"];
        const interrupted = [this.directUsage, ...this.proxyUsage.values()]
          .map(finishInterruptedUsage).some(Boolean);
        this.ensureUsageWindow();
        if (interrupted || data.version === 2) this.persistIfConfigured();
      }
    } catch (error) {
      throw new Error("Stored PartsAPI proxies could not be decrypted or validated", { cause: error });
    }
  }
}
