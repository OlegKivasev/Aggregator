import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { writeJsonStateFileAtomic } from "../session/state-file.ts";

const context = Buffer.from("autoservice-aggregator:image-search-key:v1");
export const validImageSearchKey = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{16,512}$/.test(value);

export class ImageSearchKey {
  private value: string | null = null;
  private readonly path: string;
  private readonly encryptionKey: Buffer | null;

  constructor(path: string, encryptionKey: Buffer | null) {
    this.path = path; this.encryptionKey = encryptionKey;
    if (!existsSync(path)) return;
    if (!encryptionKey) throw new Error("Encryption is required for the stored image search key");
    try {
      if (statSync(path).size > 4096) throw new Error("Invalid key envelope size");
      const envelope = JSON.parse(readFileSync(path, "utf8"));
      const decode = (value: unknown): Buffer => {
        if (typeof value !== "string" || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("Invalid key envelope");
        return Buffer.from(value, "base64");
      };
      if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") throw new Error("Invalid key envelope");
      const iv = decode(envelope.iv); const tag = decode(envelope.authTag);
      if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid key envelope");
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
      decipher.setAAD(context); decipher.setAuthTag(tag);
      const value: unknown = JSON.parse(Buffer.concat([decipher.update(decode(envelope.ciphertext)), decipher.final()]).toString("utf8"));
      if (!validImageSearchKey(value)) throw new Error("Invalid stored key");
      this.value = value;
    } catch { throw new Error("Stored image search key could not be decrypted"); }
  }
  get(): string | null { return this.value; }
  state() { return { configured: this.value !== null, persistent: this.encryptionKey !== null }; }
  set(value: string): void {
    if (!validImageSearchKey(value)) throw new Error("Invalid image search key");
    if (this.encryptionKey) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv); cipher.setAAD(context);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
      writeJsonStateFileAtomic(this.path, { version: 1, algorithm: "aes-256-gcm", iv: iv.toString("base64"),
        ciphertext: ciphertext.toString("base64"), authTag: cipher.getAuthTag().toString("base64") });
    }
    this.value = value;
  }
  delete(): void {
    if (existsSync(this.path)) rmSync(this.path);
    this.value = null;
  }
}
