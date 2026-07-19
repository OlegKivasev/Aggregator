import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { getStateFilePath } from "../../config.ts";
import type { MladovCredentials } from "../../types.ts";

export interface MladovAuthCheckResult {
  authorized: boolean;
  details: string;
}

export const mladovBaseUrl = process.env.MLADOV_BASE_URL?.trim() || "https://mladov.ru/";

const storageStatePath = getStateFilePath("mladov-storage-state.json");
const stateDir = dirname(storageStatePath);
const navigationTimeoutMs = Number(process.env.MLADOV_NAVIGATION_TIMEOUT_MS ?? "15000");
let sharedBrowserPromise: Promise<any> | null = null;

function findBrowserExecutable(): string | undefined {
  const candidates = [
    process.env.MLADOV_BROWSER_PATH,
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

async function createBrowser() {
  const { chromium } = await import("playwright");
  return chromium.launch({ headless: true, executablePath: findBrowserExecutable() });
}

export function hasMladovStorageState(): boolean {
  return existsSync(storageStatePath);
}

export function clearMladovStorageState(): void {
  if (existsSync(storageStatePath)) {
    rmSync(storageStatePath, { force: true });
  }
}

export async function getMladovSharedBrowser() {
  if (!sharedBrowserPromise) {
    sharedBrowserPromise = createBrowser().then(
      (browser) => {
        browser.once("disconnected", () => {
          sharedBrowserPromise = null;
        });
        return browser;
      },
      (error) => {
        sharedBrowserPromise = null;
        throw error;
      },
    );
  }

  return sharedBrowserPromise;
}

export async function closeMladovBrowser(): Promise<void> {
  const browserPromise = sharedBrowserPromise;
  sharedBrowserPromise = null;

  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
  }
}

export async function createMladovContext(browser: any, useStoredState = true) {
  return useStoredState && hasMladovStorageState()
    ? browser.newContext({ storageState: storageStatePath })
    : browser.newContext();
}

export async function saveMladovStorageState(context: any): Promise<void> {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  await context.storageState({ path: storageStatePath });
  chmodSync(storageStatePath, 0o600);
}

export async function isMladovAuthenticated(page: any): Promise<boolean> {
  await page.goto(new URL("/account.php", mladovBaseUrl).toString(), {
    waitUntil: "domcontentloaded",
    timeout: navigationTimeoutMs,
  });
  const hasLoginForm = (await page.locator('input[name="username"], input[name="userpassword"]').count()) > 0;
  return new URL(page.url()).pathname === "/account.php" && !hasLoginForm;
}

export async function performMladovLogin(page: any, credentials: MladovCredentials): Promise<MladovAuthCheckResult> {
  await page.goto(mladovBaseUrl, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
  const loginForm = page.locator('form:has(input[name="username"]):has(input[name="userpassword"])');
  await loginForm.locator('input[name="username"]').fill(credentials.login);
  await loginForm.locator('input[name="userpassword"]').fill(credentials.password);

  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: navigationTimeoutMs }),
    loginForm.locator('input[type="submit"][name="submit"]').click(),
  ]);

  const authorized = await isMladovAuthenticated(page);
  return {
    authorized,
    details: authorized ? "Авторизация Механик Ладов успешно проверена" : "Механик Ладов отклонил логин или пароль",
  };
}

export async function verifyMladovCredentials(credentials: MladovCredentials): Promise<MladovAuthCheckResult> {
  const browser = await getMladovSharedBrowser();
  const context = await createMladovContext(browser, false);

  try {
    const page = await context.newPage();
    const result = await performMladovLogin(page, credentials);
    if (result.authorized) {
      await saveMladovStorageState(context);
    }
    return result;
  } finally {
    await context.close();
  }
}
