import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { getStateFilePath } from "../../config.ts";
import type { ArmtekCredentials } from "../../types.ts";

export interface ArmtekAuthCheckResult {
  authorized: boolean;
  details: string;
}

interface ArmtekAuthResponse {
  status?: boolean;
  data?: {
    redirectUrl?: string;
    captchaHash?: string;
    status?: string;
    text?: string;
    clientChoice?: unknown[];
  };
  arr_messages?: Array<{ text?: string; type?: string }>;
}

export const armtekEtpUrl = process.env.ARMTEK_ETP_BASE_URL?.trim() || "https://etp.armtek.ru/";

const armtekStorageStatePath = getStateFilePath("armtek-storage-state.json");
const armtekStateDir = dirname(armtekStorageStatePath);
const armtekNavigationTimeoutMs = Number(process.env.ARMTEK_NAVIGATION_TIMEOUT_MS ?? "10000");
const armtekSettledTimeoutMs = Number(process.env.ARMTEK_SETTLED_TIMEOUT_MS ?? "4000");
const armtekPostCommitDelayMs = Number(process.env.ARMTEK_POST_COMMIT_DELAY_MS ?? "300");

let sharedArmtekBrowserPromise: Promise<any> | null = null;

function ensureArmtekStateDir() {
  mkdirSync(armtekStateDir, { recursive: true, mode: 0o700 });
}

function findBrowserExecutable(): string | undefined {
  const candidates = [
    process.env.ARMTEK_BROWSER_PATH,
    process.env.ROSSKO_BROWSER_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter((value): value is string => Boolean(value));

  return candidates.find((candidate) => existsSync(candidate));
}

function getArmtekAuthMessage(response: ArmtekAuthResponse): string {
  const messages = response.arr_messages?.map((message) => message.text?.trim()).filter(Boolean).join("; ");

  return response.data?.text || messages || "Armtek ETP rejected authorization";
}

export function hasArmtekStorageState(): boolean {
  return existsSync(armtekStorageStatePath);
}

export function clearArmtekStorageState(): void {
  if (existsSync(armtekStorageStatePath)) {
    rmSync(armtekStorageStatePath, { force: true });
  }
}

export function getArmtekCookieHeader(url = armtekEtpUrl): string | null {
  if (!hasArmtekStorageState()) {
    return null;
  }

  try {
    const hostname = new URL(url).hostname;
    const state = JSON.parse(readFileSync(armtekStorageStatePath, "utf-8")) as {
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

export async function createArmtekBrowser() {
  const { chromium } = await import("playwright");

  return chromium.launch({
    headless: true,
    executablePath: findBrowserExecutable(),
  });
}

export async function getArmtekSharedBrowser() {
  if (!sharedArmtekBrowserPromise) {
    sharedArmtekBrowserPromise = createArmtekBrowser().then(
      (browser) => {
        browser.once("disconnected", () => {
          sharedArmtekBrowserPromise = null;
        });
        return browser;
      },
      (error) => {
        sharedArmtekBrowserPromise = null;
        throw error;
      },
    );
  }

  return sharedArmtekBrowserPromise;
}

export async function closeArmtekBrowser(): Promise<void> {
  const browserPromise = sharedArmtekBrowserPromise;
  sharedArmtekBrowserPromise = null;

  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
  }
}

export async function createArmtekContext(browser: any) {
  if (hasArmtekStorageState()) {
    return browser.newContext({ storageState: armtekStorageStatePath });
  }

  return browser.newContext();
}

export async function saveArmtekStorageState(context: any): Promise<void> {
  ensureArmtekStateDir();
  await context.storageState({ path: armtekStorageStatePath });
  chmodSync(armtekStorageStatePath, 0o600);
}

export async function gotoArmtek(page: any, url: string): Promise<void> {
  await page.goto(url, {
    waitUntil: "commit",
    timeout: armtekNavigationTimeoutMs,
  });
  await page.waitForTimeout(armtekPostCommitDelayMs);
}

export async function waitForArmtekSettled(page: any) {
  try {
    await page.waitForLoadState("networkidle", { timeout: armtekSettledTimeoutMs });
  } catch {
    await page.waitForTimeout(800);
  }
}

export async function isArmtekAuthenticated(page: any): Promise<boolean> {
  const loginField = page.locator("#login:visible, input[name='login']:visible").first();
  return (await loginField.count()) === 0;
}

export async function performArmtekLogin(page: any, credentials: ArmtekCredentials): Promise<ArmtekAuthCheckResult> {
  await gotoArmtek(page, armtekEtpUrl);
  await waitForArmtekSettled(page);

  const loginField = page.locator("#login:visible, input[name='login']:visible").first();
  const passwordField = page.locator("#password:visible, input[name='password']:visible").first();

  if ((await loginField.count()) === 0 || (await passwordField.count()) === 0) {
    const authorized = await isArmtekAuthenticated(page);

    return {
      authorized,
      details: authorized ? "Armtek ETP stored session is already authorized" : `Armtek login form was not found on ${armtekEtpUrl}`,
    };
  }

  const authResponse = await page.evaluate(async ({ login, password }: ArmtekCredentials) => {
    const body = new URLSearchParams({
      LOGIN: login.startsWith("+") ? login.replace(/\+/g, "") : login,
      PASSWORD: password,
      REMEMBER: "0",
      CAPTCHA: "",
      KUNNR: "",
      CAPTCHA_HASH: "",
    });

    const response = await fetch("/authorization/auth/", {
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
  }, credentials) as { httpStatus: number; payload: ArmtekAuthResponse };

  const payload = authResponse.payload;

  if (payload.data?.captchaHash || payload.data?.status === "not_valid_captcha") {
    return {
      authorized: false,
      details: "Armtek requested captcha during authorization. Open Armtek in browser and pass captcha manually, then try again.",
    };
  }

  if (payload.data?.clientChoice?.length) {
    return {
      authorized: false,
      details: "Armtek requested client selection during authorization. Set the default client in Armtek account or log in manually once.",
    };
  }

  if (!payload.status && !payload.data?.redirectUrl) {
    const details = getArmtekAuthMessage(payload);

    return {
      authorized: false,
      details,
    };
  }

  if (payload.data?.redirectUrl) {
    const redirectUrl = new URL(payload.data.redirectUrl, armtekEtpUrl).toString();
    await gotoArmtek(page, redirectUrl);
    await waitForArmtekSettled(page);
  } else {
    await page.reload({ waitUntil: "commit", timeout: armtekNavigationTimeoutMs });
    await waitForArmtekSettled(page);
  }

  const authorized = await isArmtekAuthenticated(page);

  return {
    authorized,
    details: authorized ? "Armtek ETP account login was verified successfully" : "Armtek ETP login form is still displayed after submit",
  };
}

export async function verifyArmtekEtpCredentials(credentials: ArmtekCredentials): Promise<ArmtekAuthCheckResult> {
  const browser = await createArmtekBrowser();

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const result = await performArmtekLogin(page, credentials);

    if (result.authorized) {
      await saveArmtekStorageState(context);
    }

    return result;
  } finally {
    await browser.close();
  }
}
