import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import type { SupplierId } from "../types.ts";
import { writeJsonStateFileAtomic } from "./state-file.ts";

export interface StoredSupplierCredentials {
  login: string;
  password: string;
}

export interface SupplierCredentialRepository {
  get(supplier: SupplierId): StoredSupplierCredentials | null;
  set(supplier: SupplierId, credentials: StoredSupplierCredentials): void;
  delete(supplier: SupplierId): void;
}

interface EncryptedCredentialEnvelope {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  ciphertext: string;
  authTag: string;
}

const authenticatedContext = Buffer.from("autoservice-aggregator:supplier-credentials:v1", "utf8");
const supplierIds = new Set<SupplierId>(["rossko", "armtek", "part-kom", "stparts", "forum-auto", "motordetal", "mladov"]);

function decodeBase64Field(value: unknown, name: string): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error(`Encrypted credential store contains an invalid ${name}`);
  }
  return Buffer.from(value, "base64");
}

function parseCredentials(value: unknown): Map<SupplierId, StoredSupplierCredentials> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Encrypted credential store contains invalid credentials");
  }

  const result = new Map<SupplierId, StoredSupplierCredentials>();
  for (const [supplier, credentials] of Object.entries(value)) {
    if (!supplierIds.has(supplier as SupplierId) || !credentials || typeof credentials !== "object" || Array.isArray(credentials)) {
      throw new Error("Encrypted credential store contains invalid credentials");
    }
    const { login, password } = credentials as { login?: unknown; password?: unknown };
    if (typeof login !== "string" || !login.trim() || typeof password !== "string" || !password) {
      throw new Error("Encrypted credential store contains invalid credentials");
    }
    result.set(supplier as SupplierId, { login, password });
  }
  return result;
}

function parseEnvelope(value: unknown): EncryptedCredentialEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Encrypted credential store has an invalid format");
  }
  const envelope = value as Partial<EncryptedCredentialEnvelope>;
  if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") {
    throw new Error("Encrypted credential store has an unsupported format");
  }
  if (typeof envelope.iv !== "string" || typeof envelope.ciphertext !== "string" || typeof envelope.authTag !== "string") {
    throw new Error("Encrypted credential store has an invalid format");
  }
  return envelope as EncryptedCredentialEnvelope;
}

export class EncryptedSupplierCredentialStore implements SupplierCredentialRepository {
  private credentials = new Map<SupplierId, StoredSupplierCredentials>();
  private readonly filePath: string;
  private readonly encryptionKey: Buffer | null;

  constructor(filePath: string, encryptionKey: Buffer | null) {
    this.filePath = filePath;
    this.encryptionKey = encryptionKey;
    this.load();
  }

  get(supplier: SupplierId): StoredSupplierCredentials | null {
    const credentials = this.credentials.get(supplier);
    return credentials ? { ...credentials } : null;
  }

  set(supplier: SupplierId, credentials: StoredSupplierCredentials): void {
    const previous = this.credentials;
    this.credentials = new Map(previous).set(supplier, { ...credentials });
    try {
      this.persist();
    } catch (error) {
      this.credentials = previous;
      throw error;
    }
  }

  delete(supplier: SupplierId): void {
    if (!this.credentials.has(supplier)) {
      return;
    }
    const previous = this.credentials;
    this.credentials = new Map(previous);
    this.credentials.delete(supplier);
    try {
      this.persist();
    } catch (error) {
      this.credentials = previous;
      throw error;
    }
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      return;
    }
    if (!this.encryptionKey) {
      throw new Error("SUPPLIER_CREDENTIALS_ENCRYPTION_KEY is required to read stored supplier credentials");
    }

    try {
      const envelope = parseEnvelope(JSON.parse(readFileSync(this.filePath, "utf8")));
      const iv = decodeBase64Field(envelope.iv, "iv");
      const ciphertext = decodeBase64Field(envelope.ciphertext, "ciphertext");
      const authTag = decodeBase64Field(envelope.authTag, "authentication tag");
      if (iv.length !== 12 || authTag.length !== 16) {
        throw new Error("Encrypted credential store has invalid encryption parameters");
      }
      const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, iv);
      decipher.setAAD(authenticatedContext);
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      const payload = JSON.parse(plaintext) as { version?: unknown; credentials?: unknown };
      if (payload.version !== 1) {
        throw new Error("Encrypted credential store has an unsupported payload");
      }
      this.credentials = parseCredentials(payload.credentials);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Encrypted credential store")) {
        throw error;
      }
      throw new Error("Encrypted supplier credentials could not be decrypted", { cause: error });
    }
  }

  private persist(): void {
    if (!this.encryptionKey) {
      return;
    }
    if (!this.credentials.size) {
      rmSync(this.filePath, { force: true });
      return;
    }

    const serializedCredentials = Object.fromEntries(this.credentials);
    const plaintext = Buffer.from(JSON.stringify({ version: 1, credentials: serializedCredentials }), "utf8");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    cipher.setAAD(authenticatedContext);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    writeJsonStateFileAtomic(this.filePath, {
      version: 1,
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    } satisfies EncryptedCredentialEnvelope);
  }
}
