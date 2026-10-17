import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { writeJsonStateFileAtomic } from "../session/state-file.ts";

export interface VkChat { id: number; title: string }
export interface VkSettings { token: string; groupId: number; groupName: string; chats: VkChat[]; peerId: number | null; enabled: boolean }
const context = Buffer.from("autoservice-aggregator:vk-order-notifications:v1");
export const validVkToken = (token: unknown): token is string => typeof token === "string" && /^[a-zA-Z0-9_.-]{16,512}$/.test(token);
export const validPeerId = (id: unknown): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 2_000_000_000;

function validate(value: unknown): VkSettings {
  if (!value || typeof value !== "object") throw new Error("Invalid encrypted VK settings");
  const settings = value as VkSettings;
  if (!validVkToken(settings.token) || !Number.isSafeInteger(settings.groupId) || settings.groupId <= 0
    || typeof settings.groupName !== "string" || settings.groupName.length > 200 || typeof settings.enabled !== "boolean"
    || !Array.isArray(settings.chats) || settings.chats.length > 1_000
    || settings.chats.some((chat) => !chat || !validPeerId(chat.id) || typeof chat.title !== "string" || chat.title.length > 200)
    || new Set(settings.chats.map((chat) => chat.id)).size !== settings.chats.length
    || settings.peerId !== null && !settings.chats.some((chat) => chat.id === settings.peerId)
    || settings.enabled && settings.peerId === null) throw new Error("Invalid encrypted VK settings");
  return structuredClone(settings);
}

export class EncryptedVkSettings {
  private value: VkSettings | null = null;
  private readonly path: string;
  private readonly key: Buffer | null;
  constructor(path: string, key: Buffer | null) {
    this.path = path; this.key = key;
    if (!existsSync(path)) return;
    if (!key) throw new Error("SUPPLIER_CREDENTIALS_ENCRYPTION_KEY is required for stored VK settings");
    try {
      const envelope = JSON.parse(readFileSync(path, "utf8"));
      const decode = (field: unknown): Buffer => {
        if (typeof field !== "string" || field.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(field)) throw new Error("Invalid envelope");
        return Buffer.from(field, "base64");
      };
      if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") throw new Error("Invalid envelope");
      const iv = decode(envelope.iv); const tag = decode(envelope.authTag);
      if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid envelope");
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(context); decipher.setAuthTag(tag);
      this.value = validate(JSON.parse(Buffer.concat([decipher.update(decode(envelope.ciphertext)), decipher.final()]).toString("utf8")));
    } catch { throw new Error("Stored VK settings could not be decrypted"); }
  }
  get(): VkSettings | null { return this.value ? structuredClone(this.value) : null; }
  persistent(): boolean { return this.key !== null; }
  set(value: VkSettings): void {
    if (!this.key) throw new Error("Настройте серверное шифрование перед сохранением ключа ВК.");
    const parsed = validate(value);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv); cipher.setAAD(context);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(parsed), "utf8"), cipher.final()]);
    writeJsonStateFileAtomic(this.path, { version: 1, algorithm: "aes-256-gcm", iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), authTag: cipher.getAuthTag().toString("base64") });
    this.value = parsed;
  }
  delete(): void { rmSync(this.path, { force: true }); this.value = null; }
}
