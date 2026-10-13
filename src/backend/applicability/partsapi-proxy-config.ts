import { isIPv4 } from "node:net";

export interface PartsApiProxyConfig {
  protocol: "http" | "https";
  host: string;
  port: number;
  login: string;
  password: string;
}

export interface PartsApiProxy extends PartsApiProxyConfig {
  id: string;
}

export const maximumPartsApiProxies = 100;
export const maximumPartsApiProxyImportBytes = 512 * 1024;

export interface PartsApiUsageCounters {
  requestCount: number;
  dataResponseCount: number;
  emptyResponseCount: number;
  failedRequestCount: number;
}

export interface PartsApiUsageState extends PartsApiUsageCounters {
  windowStartedAt: number | null;
  resetAt: number | null;
  secondsUntilReset: number | null;
}

export interface PartsApiProxyState {
  persistent: boolean;
  activeRouteId: string | null;
  directLimited: boolean;
  lastSwitchReason: "manual" | "ip-limit" | null;
  usage: PartsApiUsageState;
  directUsage: PartsApiUsageCounters;
  proxies: { id: string; protocol: "http" | "https"; host: string; port: number; limited: boolean; usage: PartsApiUsageCounters }[];
}

export class PartsApiProxyValidationError extends Error {
  constructor(message = "Укажите публичный IPv4-адрес или доменное имя прокси, порт от 1 до 65535 и корректные данные доступа.") {
    super(message);
  }
}

export interface PartsApiProxyImportResult extends PartsApiProxyState {
  importedCount: number;
  duplicateCount: number;
}

export function parsePartsApiProxyImport(value: unknown): PartsApiProxyConfig[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PartsApiProxyValidationError("Некорректный файл прокси.");
  const { protocol, text } = value as Record<string, unknown>;
  if ((protocol !== "http" && protocol !== "https") || typeof text !== "string" || Buffer.byteLength(text, "utf8") > maximumPartsApiProxyImportBytes) {
    throw new PartsApiProxyValidationError("Выберите HTTP или HTTPS и текстовый файл размером до 512 КБ.");
  }
  const configs: PartsApiProxyConfig[] = [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    const fields = /^([^:]+):([0-9]{1,5}):([^:]*):(.*)$/.exec(line);
    try {
      if (!fields) throw new PartsApiProxyValidationError();
      configs.push(parsePartsApiProxyConfig({ protocol, host: fields[1].trim(), port: Number(fields[2]), login: fields[3], password: fields[4] }));
    } catch {
      throw new PartsApiProxyValidationError(`Строка ${index + 1}: ожидается адрес:порт:логин:пароль с публичным адресом и корректным портом.`);
    }
    if (configs.length > maximumPartsApiProxies) throw new PartsApiProxyValidationError("В файле должно быть не более 100 прокси.");
  }
  if (!configs.length) throw new PartsApiProxyValidationError("Файл не содержит прокси.");
  return configs;
}

export function isPublicPartsApiProxyAddress(host: string): boolean {
  if (!isIPv4(host)) return false;
  const [a, b, c] = host.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113));
}

function isProxyHost(host: string): boolean {
  if (isIPv4(host)) return isPublicPartsApiProxyAddress(host);
  if (host.length > 253 || !/^[a-z0-9.-]+$/i.test(host)) return false;
  const labels = host.split(".");
  return labels.length >= 2 && /^[a-z][a-z0-9-]*$/i.test(labels.at(-1) ?? "")
    && !["localhost", "local", "internal", "lan", "home", "test", "invalid"].includes(labels.at(-1)?.toLowerCase() ?? "")
    && labels.every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}

export function parsePartsApiProxyConfig(value: unknown): PartsApiProxyConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PartsApiProxyValidationError();
  const { protocol, host, port, login, password } = value as Record<string, unknown>;
  if ((protocol !== "http" && protocol !== "https") || typeof host !== "string" || !isProxyHost(host)
    || typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535
    || typeof login !== "string" || typeof password !== "string" || login.length > 256 || password.length > 4096
    || /[\u0000-\u001f\u007f:]/.test(login) || /[\u0000-\u001f\u007f]/.test(password)
    || Boolean(login) !== Boolean(password)) throw new PartsApiProxyValidationError();
  return { protocol, host: host.toLowerCase(), port, login, password };
}
