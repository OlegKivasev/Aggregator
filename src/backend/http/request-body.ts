import type { IncomingMessage } from "node:http";
import type { RosskoApiCredentials, SupplierId } from "../types.ts";

const requestBodyLimitBytes = 16 * 1024;
export const articleLengthLimit = 128;
export const supplierIds = new Set<SupplierId>(["rossko", "armtek", "part-kom", "stparts", "forum-auto", "motordetal", "mladov"]);

export class RequestBodyError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function parseSupplierIds(values: string[]): SupplierId[] {
  return values.filter((value): value is SupplierId => supplierIds.has(value as SupplierId));
}

export function parseSessionValidationPayload(payload: unknown): { article: string; suppliers: SupplierId[] } {
  if (!payload || typeof payload !== "object") {
    throw new RequestBodyError(400, "article and suppliers are required");
  }

  const { article, suppliers } = payload as { article?: unknown; suppliers?: unknown };
  if (typeof article !== "string" || !article.trim() || article.trim().length > articleLengthLimit) {
    throw new RequestBodyError(400, "article must be a non-empty string within the allowed length");
  }
  if (!Array.isArray(suppliers) || !suppliers.length || suppliers.some((value) => typeof value !== "string" || !supplierIds.has(value as SupplierId))) {
    throw new RequestBodyError(400, "suppliers must contain supported supplier IDs");
  }

  return { article: article.trim(), suppliers: [...new Set(parseSupplierIds(suppliers))] };
}

export function parseCredentials(payload: unknown): { login: string; password: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new RequestBodyError(400, "login and password are required");
  }

  const { login, password } = payload as { login?: unknown; password?: unknown };
  if (login === undefined || login === null || password === undefined || password === null) {
    throw new RequestBodyError(400, "login and password are required");
  }
  if (typeof login !== "string" || typeof password !== "string") {
    throw new RequestBodyError(400, "login and password must be strings within the allowed length");
  }

  const normalizedLogin = login.trim();
  if (!normalizedLogin || !password) {
    throw new RequestBodyError(400, "login and password are required");
  }
  if (normalizedLogin.length > 256 || password.length > 4_096 || /[\u0000-\u001f\u007f]/.test(normalizedLogin)) {
    throw new RequestBodyError(400, "login and password must be strings within the allowed length");
  }

  return { login: normalizedLogin, password };
}

export function parseRosskoApiCredentials(payload: unknown): RosskoApiCredentials {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new RequestBodyError(400, "K1 and K2 are required");
  }
  const { key1, key2 } = payload as { key1?: unknown; key2?: unknown };
  if (typeof key1 !== "string" || typeof key2 !== "string") {
    throw new RequestBodyError(400, "K1 and K2 must be strings within the allowed length");
  }
  const normalizedKey1 = key1.trim();
  const normalizedKey2 = key2.trim();
  if (!normalizedKey1 || !normalizedKey2) {
    throw new RequestBodyError(400, "K1 and K2 are required");
  }
  if (
    normalizedKey1.length > 256 ||
    normalizedKey2.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(normalizedKey1) ||
    /[\u0000-\u001f\u007f]/.test(normalizedKey2)
  ) {
    throw new RequestBodyError(400, "K1 and K2 must be strings within the allowed length");
  }
  return { key1: normalizedKey1, key2: normalizedKey2 };
}

export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let bodySize = 0;

  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    bodySize += buffer.byteLength;
    if (bodySize > requestBodyLimitBytes) {
      throw new RequestBodyError(413, "Request body is too large");
    }
    chunks.push(buffer);
  }

  if (!chunks.length) {
    return null;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    throw new RequestBodyError(400, "Invalid JSON request body");
  }
}
