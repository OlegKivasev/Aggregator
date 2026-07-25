import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface ArmtekApiConfig {
  login: string;
  password: string;
  vkorg?: string;
  kunnrRg?: string;
  kunnrZa?: string;
  incoterms?: string;
  vbeln?: string;
  program?: string;
  queryType: string;
}

export interface StpartsApiConfig {
  url: URL;
  login: string;
  password: string;
}

type SupplierHostnameRule = string | RegExp;

const checkoutDir = fileURLToPath(new URL("../..", import.meta.url));

function optionalEnvironmentValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function readEncryptionKey(name: string): Buffer | null {
  const value = optionalEnvironmentValue(name);
  if (!value) {
    return null;
  }
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new Error(`${name} must be a base64-encoded 32-byte key`);
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error(`${name} must be a base64-encoded 32-byte key`);
  }
  return key;
}

function readBoundedInteger(name: string, defaultValue: number, minimum: number, maximum: number): number {
  const rawValue = process.env[name];
  const value = rawValue === undefined || rawValue.trim() === "" ? defaultValue : Number(rawValue);

  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }

  return value;
}

function readSupplierUrl(name: string, defaultValue: string, hostnameRule: SupplierHostnameRule): URL {
  const configuredValue = optionalEnvironmentValue(name) || defaultValue;
  let url: URL;

  try {
    url = new URL(configuredValue);
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL`);
  }

  const hostnameAllowed = typeof hostnameRule === "string"
    ? url.hostname === hostnameRule
    : hostnameRule.test(url.hostname);
  if (
    url.protocol !== "https:" ||
    !hostnameAllowed ||
    (url.port !== "" && url.port !== "443") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must use HTTPS and an approved supplier hostname`);
  }

  return url;
}

function isInsideDirectory(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === "" || (
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  );
}

function resolvePotentialRealPath(path: string): string {
  const missingSegments: string[] = [];
  let existingPath = path;

  while (!existsSync(existingPath)) {
    const parent = dirname(existingPath);
    if (parent === existingPath) {
      return path;
    }
    missingSegments.unshift(basename(existingPath));
    existingPath = parent;
  }

  return resolve(realpathSync.native(existingPath), ...missingSegments);
}

const configuredNodeEnvironment = optionalEnvironmentValue("NODE_ENV");
if (configuredNodeEnvironment && !["development", "test", "production"].includes(configuredNodeEnvironment)) {
  throw new Error("NODE_ENV must be development, test, or production");
}

export function readPort(): number {
  return readBoundedInteger("PORT", 3000, 1, 65_535);
}

export function getStateFilePath(fileName: string): string {
  if (!fileName || fileName === "." || fileName === ".." || basename(fileName) !== fileName) {
    throw new Error("State file name must not contain a path");
  }

  const configuredStateDir = optionalEnvironmentValue("STATE_DIR");
  const stateDir = configuredStateDir ? resolve(configuredStateDir) : resolve(checkoutDir, ".state");

  if (configuredNodeEnvironment === "production") {
    if (!configuredStateDir) {
      throw new Error("STATE_DIR is required in production");
    }
    if (!isAbsolute(configuredStateDir)) {
      throw new Error("STATE_DIR must be an absolute path in production");
    }
    if (isInsideDirectory(resolvePotentialRealPath(checkoutDir), resolvePotentialRealPath(stateDir))) {
      throw new Error("STATE_DIR must be outside the application checkout in production");
    }
  }

  return resolve(stateDir, fileName);
}

export const armtekApiBaseUrl = readSupplierUrl(
  "ARMTEK_API_BASE_URL",
  "https://ws.armtek.ru/api",
  "ws.armtek.ru",
).toString();
export const armtekRequestTimeoutMs = readBoundedInteger("ARMTEK_REQUEST_TIMEOUT_MS", 15_000, 1_000, 120_000);
export const armtekSearchTimeoutMs = readBoundedInteger("ARMTEK_SEARCH_TIMEOUT_MS", 60_000, 1_000, 120_000);
export const supplierMaxResponseBytes = 5 * 1024 * 1024;
export const supplierAuthorizationTimeoutMs = readBoundedInteger("SUPPLIER_AUTHORIZATION_TIMEOUT_MS", 60_000, 1_000, 120_000);
export const supplierCredentialsEncryptionKey = readEncryptionKey("SUPPLIER_CREDENTIALS_ENCRYPTION_KEY");

export const rosskoConfig = {
  businessUrl: readSupplierUrl("ROSSKO_BASE_URL", "https://samara.rossko.ru/", /^[a-z0-9-]+\.rossko\.ru$/).toString(),
  browserPath: optionalEnvironmentValue("ROSSKO_BROWSER_PATH"),
  navigationTimeoutMs: readBoundedInteger("ROSSKO_NAVIGATION_TIMEOUT_MS", 7_000, 1_000, 120_000),
  navigationAttempts: readBoundedInteger("ROSSKO_NAVIGATION_ATTEMPTS", 2, 1, 5),
  postCommitDelayMs: readBoundedInteger("ROSSKO_POST_COMMIT_DELAY_MS", 200, 0, 10_000),
  retryDelayMs: readBoundedInteger("ROSSKO_RETRY_DELAY_MS", 250, 0, 30_000),
  settledTimeoutMs: readBoundedInteger("ROSSKO_SETTLED_TIMEOUT_MS", 3_000, 100, 120_000),
  settledFallbackDelayMs: readBoundedInteger("ROSSKO_SETTLED_FALLBACK_DELAY_MS", 800, 0, 30_000),
  loginFieldVisibleTimeoutMs: readBoundedInteger("ROSSKO_LOGIN_FIELD_VISIBLE_TIMEOUT_MS", 1_200, 100, 30_000),
  authCookieWaitTimeoutMs: readBoundedInteger("ROSSKO_AUTH_COOKIE_WAIT_TIMEOUT_MS", 8_000, 100, 120_000),
  authCookiePollIntervalMs: readBoundedInteger("ROSSKO_AUTH_COOKIE_POLL_INTERVAL_MS", 250, 50, 10_000),
  authResponseTimeoutMs: readBoundedInteger("ROSSKO_AUTH_RESPONSE_TIMEOUT_MS", 8_000, 100, 120_000),
  apiRequestAttempts: readBoundedInteger("ROSSKO_API_REQUEST_ATTEMPTS", 3, 1, 5),
  apiHedgeDelayMs: readBoundedInteger("ROSSKO_API_HEDGE_DELAY_MS", 1_200, 100, 30_000),
  apiRequestTimeoutMs: readBoundedInteger("ROSSKO_API_REQUEST_TIMEOUT_MS", 6_000, 1_000, 120_000),
  searchTimeoutMs: readBoundedInteger("ROSSKO_SEARCH_TIMEOUT_MS", 30_000, 1_000, 120_000),
};

export const mladovConfig = {
  baseUrl: readSupplierUrl("MLADOV_BASE_URL", "https://mladov.ru/", "mladov.ru").toString(),
  browserPath: optionalEnvironmentValue("MLADOV_BROWSER_PATH"),
  navigationTimeoutMs: readBoundedInteger("MLADOV_NAVIGATION_TIMEOUT_MS", 15_000, 1_000, 120_000),
  requestTimeoutMs: readBoundedInteger("MLADOV_SEARCH_TIMEOUT_MS", 15_000, 1_000, 120_000),
  searchTimeoutMs: readBoundedInteger("MLADOV_SEARCH_TIMEOUT_MS", 20_000, 1_000, 120_000),
};

export const motorDetalConfig = {
  baseUrl: readSupplierUrl("MOTORDETAL_BASE_URL", "https://sales.motordetal.ru/", "sales.motordetal.ru").toString(),
  requestTimeoutMs: readBoundedInteger("MOTORDETAL_REQUEST_TIMEOUT_MS", 15_000, 1_000, 120_000),
  searchTimeoutMs: readBoundedInteger("MOTORDETAL_SEARCH_TIMEOUT_MS", 15_000, 1_000, 120_000),
};

export const partKomSearchTimeoutMs = readBoundedInteger("PARTKOM_SEARCH_TIMEOUT_MS", 15_000, 1, 120_000);

export const stpartsConfig = {
  apiUrl: readSupplierUrl("STPARTS_API_URL", "https://stpartsru.public.api.abcp.ru/", "stpartsru.public.api.abcp.ru"),
  baseUrl: readSupplierUrl("STPARTS_BASE_URL", "https://stparts.ru/", "stparts.ru").toString(),
  browserPath: optionalEnvironmentValue("STPARTS_BROWSER_PATH"),
  searchTimeoutMs: readBoundedInteger("STPARTS_SEARCH_TIMEOUT_MS", 10_000, 1_000, 120_000),
  navigationTimeoutMs: readBoundedInteger("STPARTS_NAVIGATION_TIMEOUT_MS", 15_000, 1_000, 120_000),
  settledTimeoutMs: readBoundedInteger("STPARTS_SETTLED_TIMEOUT_MS", 4_000, 100, 120_000),
  postCommitDelayMs: readBoundedInteger("STPARTS_POST_COMMIT_DELAY_MS", 300, 0, 30_000),
  sessionProbeTimeoutMs: readBoundedInteger("STPARTS_SESSION_PROBE_TIMEOUT_MS", 5_000, 100, 120_000),
};

export function getArmtekApiConfig(): ArmtekApiConfig | null {
  const login = optionalEnvironmentValue("ARMTEK_LOGIN");
  const password = process.env.ARMTEK_PASSWORD;

  if (!login || !password) {
    return null;
  }

  return {
    login,
    password,
    vkorg: optionalEnvironmentValue("ARMTEK_VKORG"),
    kunnrRg: optionalEnvironmentValue("ARMTEK_KUNNR_RG"),
    kunnrZa: optionalEnvironmentValue("ARMTEK_KUNNR_ZA"),
    incoterms: optionalEnvironmentValue("ARMTEK_INCOTERMS"),
    vbeln: optionalEnvironmentValue("ARMTEK_VBELN"),
    program: optionalEnvironmentValue("ARMTEK_PROGRAM"),
    queryType: optionalEnvironmentValue("ARMTEK_QUERY_TYPE") || "1",
  };
}

export function getStpartsApiConfig(credentials?: { login: string; password: string }): StpartsApiConfig | null {
  const login = credentials?.login.trim() || optionalEnvironmentValue("STPARTS_API_LOGIN");
  const password = credentials?.password || process.env.STPARTS_API_PASSWORD;

  return login && password ? { url: new URL(stpartsConfig.apiUrl), login, password } : null;
}
