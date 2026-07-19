import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { getStateFilePath } from "../../config.ts";
import type { PartKomCredentials } from "../../types.ts";

export interface PartKomAuthCheckResult {
  authorized: boolean;
  details: string;
}

interface PartKomLoginResponse {
  success?: boolean;
  msg?: string;
  errors?: Record<string, string | string[]>;
  data?: unknown;
}

interface PartKomAuthProbeResponse {
  success?: boolean;
  msg?: string;
  message?: string;
}

export const partKomBaseUrl = process.env.PARTKOM_BASE_URL?.trim() || "https://www.part-kom.ru/";
export const partKomApiBaseUrl = process.env.PARTKOM_API_BASE_URL?.trim() || "https://b2b.part-kom.ru/";

const partKomStorageStatePath = getStateFilePath("part-kom-storage-state.json");
const partKomStateDir = dirname(partKomStorageStatePath);
const partKomNavigationTimeoutMs = Number(process.env.PARTKOM_NAVIGATION_TIMEOUT_MS ?? "15000");
const partKomSettledTimeoutMs = Number(process.env.PARTKOM_SETTLED_TIMEOUT_MS ?? "4000");
const partKomPostCommitDelayMs = Number(process.env.PARTKOM_POST_COMMIT_DELAY_MS ?? "300");
const partKomAuthProbeTimeoutMs = Number(process.env.PARTKOM_AUTH_PROBE_TIMEOUT_MS ?? "5000");

function ensurePartKomStateDir() {
  mkdirSync(partKomStateDir, { recursive: true, mode: 0o700 });
}

function findBrowserExecutable(): string | undefined {
  const candidates = [
    process.env.PARTKOM_BROWSER_PATH,
    process.env.ARMTEK_BROWSER_PATH,
    process.env.ROSSKO_BROWSER_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter((value): value is string => Boolean(value));

  return candidates.find((candidate) => existsSync(candidate));
}

function formatPartKomAuthError(response: PartKomLoginResponse): string {
  const errors = response.errors
    ? Object.values(response.errors)
        .flatMap((value) => (Array.isArray(value) ? value : [value]))
        .map((value) => value.trim())
        .filter(Boolean)
        .join("; ")
    : "";

  return response.msg || errors || "Part-Kom rejected authorization";
}

export function hasPartKomStorageState(): boolean {
  return existsSync(partKomStorageStatePath);
}

export function clearPartKomStorageState(): void {
  if (existsSync(partKomStorageStatePath)) {
    rmSync(partKomStorageStatePath, { force: true });
  }
}

export function getPartKomCookieHeader(url = partKomApiBaseUrl): string | null {
  if (!hasPartKomStorageState()) {
    return null;
  }

  try {
    const hostname = new URL(url).hostname;
    const state = JSON.parse(readFileSync(partKomStorageStatePath, "utf-8")) as {
      cookies?: Array<{ name?: string; value?: string; domain?: string }>;
    };
    const cookies = (state.cookies || []).filter((cookie) => {
      const domain = cookie.domain?.replace(/^\./, "");
      return cookie.name && cookie.value && domain && (hostname === domain || hostname.endsWith(`.${domain}`));
    });
    return cookies.length ? cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") : null;
  } catch {
    return null;
  }
}

export async function createPartKomBrowser() {
  const { chromium } = await import("playwright");

  return chromium.launch({
    headless: true,
    executablePath: findBrowserExecutable(),
  });
}

export async function savePartKomStorageState(context: any): Promise<void> {
  ensurePartKomStateDir();
  await context.storageState({ path: partKomStorageStatePath });
  chmodSync(partKomStorageStatePath, 0o600);
}

export async function gotoPartKom(page: any, url: string): Promise<void> {
  await page.goto(url, {
    waitUntil: "commit",
    timeout: partKomNavigationTimeoutMs,
  });
  await page.waitForTimeout(partKomPostCommitDelayMs);
}

export async function waitForPartKomSettled(page: any) {
  try {
    await page.waitForLoadState("networkidle", { timeout: partKomSettledTimeoutMs });
  } catch {
    await page.waitForTimeout(800);
  }
}

export async function isPartKomAuthenticated(page: any): Promise<boolean> {
  await gotoPartKom(page, partKomBaseUrl);
  await waitForPartKomSettled(page);

  const probe = (await page.evaluate(async (timeoutMs: number) => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch("/autocomplete_api_v2/?q=OC90", {
        headers: { "X-Requested-With": "XMLHttpRequest" },
        signal: controller.signal,
      });

      return await response.json();
    } catch (error) {
      return {
        probeFailed: true,
        message: error instanceof Error ? error.message : "Part-Kom auth probe failed",
      };
    } finally {
      window.clearTimeout(timeoutId);
    }
  }, partKomAuthProbeTimeoutMs)) as PartKomAuthProbeResponse & { probeFailed?: boolean };

  if (probe.probeFailed) {
    return true;
  }

  const message = probe.msg || probe.message;
  const authorized = message !== "unauthorized" && probe.success !== false;

  return authorized;
}

export async function performPartKomLogin(page: any, credentials: PartKomCredentials): Promise<PartKomAuthCheckResult> {
  await gotoPartKom(page, partKomBaseUrl);
  await waitForPartKomSettled(page);

  const authResponse = (await page.evaluate(async ({ login, password }: PartKomCredentials) => {
    const body = new URLSearchParams({
      txtLogin: login,
      txtPassword: password,
      cbSaveLogin: "1",
      yandexCaptchaToken: "",
    });

    const response = await fetch("/new/app/?method=User_Login", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
      },
      body,
    });

    return {
      httpStatus: response.status,
      payload: await response.json(),
    };
  }, credentials)) as { httpStatus: number; payload: PartKomLoginResponse };

  if (!authResponse.payload.success) {
    const details = formatPartKomAuthError(authResponse.payload);

    return {
      authorized: false,
      details,
    };
  }

  await page.reload({ waitUntil: "commit", timeout: partKomNavigationTimeoutMs });
  await waitForPartKomSettled(page);

  const authorized = await isPartKomAuthenticated(page);

  return {
    authorized,
    details: authorized ? "Part-Kom wholesale account login was verified successfully" : "Part-Kom login did not produce an authorized session",
  };
}

export async function verifyPartKomCredentials(credentials: PartKomCredentials): Promise<PartKomAuthCheckResult> {
  const browser = await createPartKomBrowser();

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const result = await performPartKomLogin(page, credentials);

    if (result.authorized) {
      await savePartKomStorageState(context);
    }

    return result;
  } finally {
    await browser.close();
  }
}
