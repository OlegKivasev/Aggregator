import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { writeJsonStateFileAtomic } from "../session/state-file.ts";

interface EncryptedApiKeyEnvelope {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  ciphertext: string;
  authTag: string;
}

interface StoredApiKey {
  version: 1;
  apiKey: string;
}

const authenticatedContext = Buffer.from("autoservice-aggregator:partsapi-key:v1", "utf8");

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

function parseStoredApiKey(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PartsAPI key store has an invalid key");
  }
  const payload = value as Partial<StoredApiKey>;
  if (payload.version !== 1 || typeof payload.apiKey !== "string" || !payload.apiKey || payload.apiKey.length > 512) {
    throw new Error("PartsAPI key store has an invalid key");
  }
  return payload.apiKey;
}

export class EncryptedApplicabilityApiKeyStore {
  private apiKey: string | null = null;
  private readonly filePath: string;
  private readonly encryptionKey: Buffer | null;

  constructor(filePath: string, encryptionKey: Buffer | null) {
    this.filePath = filePath;
    this.encryptionKey = encryptionKey;
    this.load();
  }

  get(): string | null {
    return this.apiKey;
  }

  isPersistent(): boolean {
    return this.encryptionKey !== null;
  }

  set(apiKey: string): void {
    const previous = this.apiKey;
    this.apiKey = apiKey;
    try {
      this.persist();
    } catch (error) {
      this.apiKey = previous;
      throw error;
    }
  }

  delete(): void {
    const previous = this.apiKey;
    this.apiKey = null;
    try {
      this.persist();
    } catch (error) {
      this.apiKey = previous;
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
      this.apiKey = parseStoredApiKey(JSON.parse(plaintext));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("PartsAPI key store")) throw error;
      throw new Error("Stored PartsAPI key could not be decrypted", { cause: error });
    }
  }

  private persist(): void {
    if (!this.encryptionKey) return;
    if (!this.apiKey) {
      rmSync(this.filePath, { force: true });
      return;
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    cipher.setAAD(authenticatedContext);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify({ version: 1, apiKey: this.apiKey } satisfies StoredApiKey), "utf8")), cipher.final()]);
    writeJsonStateFileAtomic(this.filePath, {
      version: 1,
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    } satisfies EncryptedApiKeyEnvelope);
  }
}
