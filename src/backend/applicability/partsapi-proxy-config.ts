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
  constructor() {
    super("Укажите публичный IPv4-адрес, порт от 1 до 65535 и корректные данные прокси.");
  }
}

export function parsePartsApiProxyConfig(value: unknown): PartsApiProxyConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PartsApiProxyValidationError();
  const { protocol, host, port, login, password } = value as Record<string, unknown>;
  if ((protocol !== "http" && protocol !== "https") || typeof host !== "string" || !isIPv4(host)
    || typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535
    || typeof login !== "string" || typeof password !== "string" || login.length > 256 || password.length > 4096
    || /[\u0000-\u001f\u007f:]/.test(login) || /[\u0000-\u001f\u007f]/.test(password)
    || Boolean(login) !== Boolean(password)) throw new PartsApiProxyValidationError();
  const [a, b, c] = host.split(".").map(Number);
  // Only public IPv4 proxies: configuration cannot target local services or cloud metadata.
  if (a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)) throw new PartsApiProxyValidationError();
  return { protocol, host, port, login, password };
}
