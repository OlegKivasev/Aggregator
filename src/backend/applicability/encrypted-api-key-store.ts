import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { writeJsonStateFileAtomic } from "../session/state-file.ts";
import type { ApplicabilityApiKeyState, ApplicabilityKeyStatus } from "./types.ts";
import { SupplierIntegrationError } from "../errors.ts";
import { PartsApiKeyError } from "./partsapi-key-error.ts";

interface EncryptedApiKeyEnvelope {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  ciphertext: string;
  authTag: string;
}

interface StoredKey {
  apiKey: string;
  firstRequestAt: number | null;
  limited: boolean;
  requestCount: number;
}

interface StoredApiKeys {
  version: 3;
  primaryKey: StoredKey | null;
  fallbackKeys: StoredKey[];
  activeKeyIndex: number | null;
}

const authenticatedContext = Buffer.from("autoservice-aggregator:partsapi-key:v1", "utf8");
const quotaWindowMs = 24 * 60 * 60 * 1000;
const newKey = (apiKey: string): StoredKey => ({ apiKey, firstRequestAt: null, limited: false, requestCount: 0 });

function decodeBase64Field(value: unknown, name: string): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error(`PartsAPI key store contains an invalid ${name}`);
  }
  return Buffer.from(value, "base64");
}

function parseEnvelope(value: unknown): EncryptedApiKeyEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PartsAPI key store has an invalid format");
  }
  const envelope = value as Partial<EncryptedApiKeyEnvelope>;
  if (
    envelope.version !== 1 ||
    envelope.algorithm !== "aes-256-gcm" ||
    typeof envelope.iv !== "string" ||
    typeof envelope.ciphertext !== "string" ||
    typeof envelope.authTag !== "string"
  ) {
    throw new Error("PartsAPI key store has an invalid format");
  }
  return envelope as EncryptedApiKeyEnvelope;
}

function parseApiKey(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value || value.length > 512) {
    throw new Error("PartsAPI key store has an invalid key");
  }
  return value;
}

function parseFallbackApiKeys(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((apiKey) => typeof apiKey !== "string" || !apiKey || apiKey.length > 512)) {
    throw new Error("PartsAPI key store has invalid fallback keys");
  }
  return value;
}

function parseStoredKey(value: unknown): StoredKey {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PartsAPI key store has an invalid key state");
  const key = value as Partial<StoredKey>;
  const apiKey = parseApiKey(key.apiKey);
  if (!apiKey || typeof key.limited !== "boolean" || (key.firstRequestAt !== null
    && (!Number.isSafeInteger(key.firstRequestAt) || typeof key.firstRequestAt !== "number" || key.firstRequestAt < 0
      || key.firstRequestAt > 8_640_000_000_000_000 - quotaWindowMs)) || (key.limited && key.firstRequestAt === null)
    || typeof key.requestCount !== "number" || !Number.isSafeInteger(key.requestCount) || key.requestCount < 0
    || (key.requestCount > 0 && key.firstRequestAt === null)) {
    throw new Error("PartsAPI key store has an invalid key state");
  }
  return { apiKey, firstRequestAt: key.firstRequestAt, limited: key.limited, requestCount: key.requestCount };
}

function parseStoredApiKeys(value: unknown): StoredApiKeys {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PartsAPI key store has an invalid key");
  }
  const payload = value as { version?: unknown; apiKey?: unknown; fallbackApiKeys?: unknown; primaryKey?: unknown; fallbackKeys?: unknown; activeKeyIndex?: unknown };
  if (payload.version === 1 || payload.version === 2) {
    const apiKey = parseApiKey(payload.apiKey);
    const fallbackKeys = payload.version === 1 ? [] : parseFallbackApiKeys(payload.fallbackApiKeys).map(newKey);
    return { version: 3, primaryKey: apiKey ? newKey(apiKey) : null, fallbackKeys, activeKeyIndex: apiKey ? 0 : fallbackKeys.length ? 1 : null };
  }
  if (payload.version !== 3 || !Array.isArray(payload.fallbackKeys)) throw new Error("PartsAPI key store has an invalid key");
  const primaryKey = payload.primaryKey === null ? null : parseStoredKey(payload.primaryKey);
  const fallbackKeys = payload.fallbackKeys.map(parseStoredKey);
  const index = payload.activeKeyIndex;
  if (index !== null && (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0
    || index > fallbackKeys.length || (index === 0 && !primaryKey))) throw new Error("PartsAPI key store has an invalid active key");
  return {
    version: 3, primaryKey, fallbackKeys, activeKeyIndex: index,
  };
}

export class EncryptedApplicabilityApiKeyStore {
  private keys: StoredApiKeys = { version: 3, primaryKey: null, fallbackKeys: [], activeKeyIndex: null };
  private readonly filePath: string;
  private readonly encryptionKey: Buffer | null;
  private readonly now: () => number;

  constructor(filePath: string, encryptionKey: Buffer | null, now: () => number = Date.now) {
    this.filePath = filePath;
    this.encryptionKey = encryptionKey;
    this.now = now;
    this.load();
  }

  get(): string | null {
    return this.keys.primaryKey?.apiKey ?? null;
  }

  getFallbackKeyCount(): number {
    return this.keys.fallbackKeys.length;
  }

  isPersistent(): boolean {
    return this.encryptionKey !== null;
  }

  set(apiKey: string): void {
    this.update(() => {
      this.keys.primaryKey = { ...(this.allKeys().find((key) => key?.apiKey === apiKey) ?? newKey(apiKey)) };
      if (!this.keys.primaryKey.limited) this.keys.activeKeyIndex = 0;
    });
  }

  delete(): void {
    this.update(() => {
      this.keys.primaryKey = null;
      if (this.keys.activeKeyIndex === 0) this.keys.activeKeyIndex = null;
    });
  }

  addFallbackKey(apiKey: string): void {
    this.update(() => {
      this.keys.fallbackKeys.push({ ...(this.allKeys().find((key) => key?.apiKey === apiKey) ?? newKey(apiKey)) });
    });
  }

  deleteFallbackKey(index: number): void {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.keys.fallbackKeys.length) {
      throw new Error("PartsAPI fallback key does not exist");
    }
    this.update(() => {
      this.keys.fallbackKeys.splice(index, 1);
      if (this.keys.activeKeyIndex === index + 1) this.keys.activeKeyIndex = null;
      else if (this.keys.activeKeyIndex !== null && this.keys.activeKeyIndex > index + 1) this.keys.activeKeyIndex -= 1;
    });
  }

  getActiveKey(): string | null {
    this.refresh();
    return this.activeKey()?.apiKey ?? null;
  }

  getState(): ApplicabilityApiKeyState {
    this.refresh();
    const status = (key: StoredKey, index: number): ApplicabilityKeyStatus => ({
      maskedKey: [...key.apiKey].length > 5 ? `…${[...key.apiKey].slice(-5).join("")}` : "…",
      active: this.keys.activeKeyIndex === index,
      limited: key.limited,
      resetAt: key.firstRequestAt === null ? null : key.firstRequestAt + quotaWindowMs,
      requestCount: key.requestCount,
    });
    return {
      configured: this.allKeys().some(Boolean), persistent: this.isPersistent(), fallbackKeyCount: this.keys.fallbackKeys.length,
      primaryKey: this.keys.primaryKey ? status(this.keys.primaryKey, 0) : null,
      fallbackKeys: this.keys.fallbackKeys.map((key, index) => status(key, index + 1)),
    };
  }

  markLimited(apiKey: string): void {
    if (!this.allKeys().some((key) => key?.apiKey === apiKey)) return;
    this.update(() => {
      for (const key of this.allKeys()) {
        if (key?.apiKey !== apiKey) continue;
        // Existing stores have no request history; begin a conservative window at the first observed limit.
        key.firstRequestAt ??= this.now();
        key.limited = true;
      }
    });
  }

  recordRequest(apiKey: string): void {
    if (!this.allKeys().some((key) => key?.apiKey === apiKey)) return;
    this.update(() => {
      for (const key of this.allKeys()) {
        if (key?.apiKey !== apiKey) continue;
        key.firstRequestAt ??= this.now();
        if (key.requestCount === Number.MAX_SAFE_INTEGER) throw new Error("PartsAPI request counter exceeded its supported range");
        key.requestCount += 1;
      }
    });
  }

  selectActiveKey(index: number): void {
    this.refresh();
    const key = Number.isSafeInteger(index) && index >= 0 ? this.allKeys()[index] : null;
    if (!key) throw new SupplierIntegrationError("PartsAPI key does not exist", { publicMessage: "Сохранённый ключ не найден. Обновите настройки." });
    if (key.limited) throw new PartsApiKeyError(key.apiKey, true);
    this.update(() => { this.keys.activeKeyIndex = index; });
  }

  private allKeys(): (StoredKey | null)[] {
    return [this.keys.primaryKey, ...this.keys.fallbackKeys];
  }

  private activeKey(): StoredKey | null {
    return this.keys.activeKeyIndex === null ? null : this.allKeys()[this.keys.activeKeyIndex] ?? null;
  }

  private refresh(): void {
    const now = this.now();
    if (this.allKeys().some((key) => key && key.firstRequestAt !== null && now >= key.firstRequestAt + quotaWindowMs)
      || !this.activeKey() || this.activeKey()?.limited) this.update(() => {});
  }

  private update(change: () => void): void {
    const previous = this.keys;
    this.keys = structuredClone(previous);
    try {
      const now = this.now();
      for (const key of this.allKeys()) {
        if (key && key.firstRequestAt !== null && now >= key.firstRequestAt + quotaWindowMs) {
          key.firstRequestAt = null;
          key.limited = false;
          key.requestCount = 0;
        }
      }
      change();
      if (!this.activeKey() || this.activeKey()?.limited) {
        const index = this.allKeys().findIndex((key) => key && !key.limited);
        this.keys.activeKeyIndex = index < 0 ? null : index;
      }
      if (JSON.stringify(previous) !== JSON.stringify(this.keys)) this.persist();
    } catch (error) {
      this.keys = previous;
      throw error;
    }
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    if (!this.encryptionKey) {
      throw new Error("SUPPLIER_CREDENTIALS_ENCRYPTION_KEY is required to read the stored PartsAPI key");
    }
    try {
      const envelope = parseEnvelope(JSON.parse(readFileSync(this.filePath, "utf8")));
      const iv = decodeBase64Field(envelope.iv, "iv");
      const ciphertext = decodeBase64Field(envelope.ciphertext, "ciphertext");
      const authTag = decodeBase64Field(envelope.authTag, "authentication tag");
      if (iv.length !== 12 || authTag.length !== 16) {
        throw new Error("PartsAPI key store has invalid encryption parameters");
      }
      const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, iv);
      decipher.setAAD(authenticatedContext);
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      this.keys = parseStoredApiKeys(JSON.parse(plaintext));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("PartsAPI key store")) throw error;
      throw new Error("Stored PartsAPI key could not be decrypted", { cause: error });
    }
  }

  private persist(): void {
    if (!this.encryptionKey) return;
    if (!this.keys.primaryKey && !this.keys.fallbackKeys.length) {
      rmSync(this.filePath, { force: true });
      return;
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    cipher.setAAD(authenticatedContext);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(this.keys), "utf8")), cipher.final()]);
    writeJsonStateFileAtomic(this.filePath, {
      version: 1,
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    } satisfies EncryptedApiKeyEnvelope);
  }
}
