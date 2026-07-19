import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { getStateFilePath } from "../../config.ts";
import type { StpartsCredentials } from "../../types.ts";

export interface StpartsAuthCheckResult {
  authorized: boolean;
  details: string;
}

export const stpartsBaseUrl = process.env.STPARTS_BASE_URL?.trim() || "https://stparts.ru/";

const stpartsStorageStatePath = getStateFilePath("stparts-storage-state.json");
const stpartsStateDir = dirname(stpartsStorageStatePath);
const stpartsNavigationTimeoutMs = Number(process.env.STPARTS_NAVIGATION_TIMEOUT_MS ?? "6000");
const stpartsSettledTimeoutMs = Number(process.env.STPARTS_SETTLED_TIMEOUT_MS ?? "4000");
const stpartsPostCommitDelayMs = Number(process.env.STPARTS_POST_COMMIT_DELAY_MS ?? "300");
const authErrorPattern = /невер|неправ|ошиб|парол|логин|email|почт|авторизац/i;

function ensureStpartsStateDir() {
  mkdirSync(stpartsStateDir, { recursive: true, mode: 0o700 });
}

function findBrowserExecutable(): string | undefined {
  const candidates = [
    process.env.STPARTS_BROWSER_PATH,
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

export function hasStpartsStorageState(): boolean {
  return existsSync(stpartsStorageStatePath);
}

export function clearStpartsStorageState(): void {
  if (existsSync(stpartsStorageStatePath)) {
    rmSync(stpartsStorageStatePath, { force: true });
  }
}

export function getStpartsCookieHeader(url = stpartsBaseUrl): string | null {
  if (!hasStpartsStorageState()) {
    return null;
  }

  try {
    const hostname = new URL(url).hostname;
    const state = JSON.parse(readFileSync(stpartsStorageStatePath, "utf-8")) as {
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

export async function createStpartsBrowser() {
  const { chromium } = await import("playwright");

  return chromium.launch({
    headless: true,
    executablePath: findBrowserExecutable(),
  });
}

export async function saveStpartsStorageState(context: any): Promise<void> {
  ensureStpartsStateDir();
  await context.storageState({ path: stpartsStorageStatePath });
  chmodSync(stpartsStorageStatePath, 0o600);
}

export async function gotoStparts(page: any, url: string): Promise<void> {
  await page.goto(url, {
    waitUntil: "commit",
    timeout: stpartsNavigationTimeoutMs,
  });
  await page.waitForTimeout(stpartsPostCommitDelayMs);
}

export async function waitForStpartsSettled(page: any) {
  try {
    await page.waitForLoadState("networkidle", { timeout: stpartsSettledTimeoutMs });
  } catch {
    await page.waitForTimeout(800);
  }
}

async function getStpartsVisibleAuthError(page: any): Promise<string | null> {
  const candidates = page.locator(".error, .errors, .message_error, .auth-error, .jGrowl-message:visible").first();

  if ((await candidates.count()) > 0) {
    const text = (await candidates.innerText()).trim();
    if (text) {
      return text;
    }
  }

  const bodyText = await page.locator("body").innerText().catch(() => "");
  return authErrorPattern.test(bodyText) ? "STParts rejected the login or password" : null;
}

export async function isStpartsAuthenticated(page: any): Promise<boolean> {
  await gotoStparts(page, stpartsBaseUrl);
  await waitForStpartsSettled(page);

  const loginField = page.locator('#lgnform input[name="login"]:visible, #login:visible').first();
  if ((await loginField.count()) > 0) {
    return false;
  }

  const authorizedMarkers = page.locator('a[href*="logout"], a[href*="/personal"], a[href*="/profile"], .basketLegendContainer').first();
  return (await authorizedMarkers.count()) > 0;
}

export async function performStpartsLogin(page: any, credentials: StpartsCredentials): Promise<StpartsAuthCheckResult> {
  await gotoStparts(page, stpartsBaseUrl);
  await waitForStpartsSettled(page);

  const loginField = page.locator('#lgnform input[name="login"], #login, input[name="login"]').first();
  const passwordField = page.locator('#lgnform input[name="pass"], #pass, input[name="pass"], input[type="password"]').first();

  if ((await loginField.count()) === 0 || (await passwordField.count()) === 0) {
    return {
      authorized: false,
      details: `STParts login form was not found on ${stpartsBaseUrl}`,
    };
  }

  await loginField.fill(credentials.login);
  await passwordField.fill(credentials.password);

  const form = page.locator("#lgnform").first();
  const submitButton = form.locator('input[type="submit"], button[type="submit"], button, input[name="go"]').first();

  if ((await submitButton.count()) > 0) {
    await submitButton.click();
  } else {
    await passwordField.press("Enter");
  }

  await waitForStpartsSettled(page);

  const authorized = await isStpartsAuthenticated(page);

  if (!authorized) {
    const details = (await getStpartsVisibleAuthError(page)) || "STParts login did not produce an authorized session";

    return {
      authorized: false,
      details,
    };
  }

  return {
    authorized: true,
    details: "STParts account login was verified successfully",
  };
}

export async function verifyStpartsCredentials(credentials: StpartsCredentials): Promise<StpartsAuthCheckResult> {
  const browser = await createStpartsBrowser();

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const result = await performStpartsLogin(page, credentials);

    if (result.authorized) {
      await saveStpartsStorageState(context);
    }

    return result;
  } finally {
    await browser.close();
  }
}
