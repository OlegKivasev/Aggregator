import { existsSync, rmSync } from "node:fs";
import { getStateFilePath, mladovConfig } from "../../config.ts";
import { writeJsonStateFileAtomic } from "../../session/state-file.ts";
import type { MladovCredentials } from "../../types.ts";

export interface MladovAuthCheckResult {
  authorized: boolean;
  details: string;
}

export const mladovBaseUrl = mladovConfig.baseUrl;

const storageStatePath = getStateFilePath("mladov-storage-state.json");
const navigationTimeoutMs = mladovConfig.navigationTimeoutMs;
let sharedBrowserPromise: Promise<any> | null = null;
let storageStateGeneration = 0;

export function getMladovStorageStateGeneration(): number {
  return storageStateGeneration;
}

async function waitForResource<T>(
  resourcePromise: Promise<T>,
  signal?: AbortSignal,
  disposeLateResource?: (resource: T) => Promise<void>,
): Promise<T> {
  if (!signal) {
    return resourcePromise;
  }
  if (signal.aborted) {
    if (disposeLateResource) {
      resourcePromise.then(disposeLateResource).catch(() => undefined);
    }
    throw signal.reason;
  }

  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    resourcePromise.then(
      (resource) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) {
          disposeLateResource?.(resource).catch(() => undefined);
          reject(signal.reason);
          return;
        }
        resolve(resource);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function findBrowserExecutable(): string | undefined {
  const candidates = [
    mladovConfig.browserPath,
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
  storageStateGeneration += 1;
  if (existsSync(storageStatePath)) {
    rmSync(storageStatePath, { force: true });
  }
}

export async function getMladovSharedBrowser(signal?: AbortSignal): Promise<any> {
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

  return waitForResource(sharedBrowserPromise, signal);
}

export async function closeMladovBrowser(): Promise<void> {
  const browserPromise = sharedBrowserPromise;
  sharedBrowserPromise = null;

  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
  }
}

export async function createMladovContext(browser: any, useStoredState = true, signal?: AbortSignal): Promise<any> {
  const contextPromise: Promise<any> = useStoredState && hasMladovStorageState()
    ? browser.newContext({ storageState: storageStatePath })
    : browser.newContext();
  return waitForResource(contextPromise, signal, (context) => context.close());
}

export async function saveMladovStorageState(
  context: any,
  expectedGeneration: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const state = await context.storageState();
  signal?.throwIfAborted();
  writeJsonStateFileAtomic(
    storageStatePath,
    state,
    () => storageStateGeneration === expectedGeneration && !signal?.aborted,
  );
}

export async function isMladovAuthenticated(page: any, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  await page.goto(new URL("/account.php", mladovBaseUrl).toString(), {
    waitUntil: "domcontentloaded",
    timeout: navigationTimeoutMs,
  });
  signal?.throwIfAborted();
  const hasLoginForm = (await page.locator('input[name="username"], input[name="userpassword"]').count()) > 0;
  const hasAuthorizedMarker = (await page.locator('a[href*="logout"], a[href*="exit"], form[action*="logout"]').count()) > 0;
  return new URL(page.url()).pathname === "/account.php" && !hasLoginForm && hasAuthorizedMarker;
}

export async function performMladovLogin(
  page: any,
  credentials: MladovCredentials,
  signal?: AbortSignal,
): Promise<MladovAuthCheckResult> {
  signal?.throwIfAborted();
  await page.goto(mladovBaseUrl, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
  const loginForm = page.locator('form:has(input[name="username"]):has(input[name="userpassword"])');
  await loginForm.locator('input[name="username"]').fill(credentials.login);
  await loginForm.locator('input[name="userpassword"]').fill(credentials.password);

  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: navigationTimeoutMs }),
    loginForm.locator('input[type="submit"][name="submit"]').click(),
  ]);

  signal?.throwIfAborted();
  const authorized = await isMladovAuthenticated(page, signal);
  return {
    authorized,
    details: authorized ? "Авторизация Механик Ладов успешно проверена" : "Механик Ладов отклонил логин или пароль",
  };
}

export async function verifyMladovCredentials(
  credentials: MladovCredentials,
  signal?: AbortSignal,
): Promise<MladovAuthCheckResult> {
  storageStateGeneration += 1;
  const expectedGeneration = storageStateGeneration;
  const browser = await getMladovSharedBrowser(signal);
  const context = await createMladovContext(browser, false, signal);
  const closeOnAbort = () => context.close().catch(() => undefined);
  signal?.addEventListener("abort", closeOnAbort, { once: true });

  try {
    signal?.throwIfAborted();
    const page = await context.newPage();
    const result = await performMladovLogin(page, credentials, signal);
    if (result.authorized) {
      signal?.throwIfAborted();
      await saveMladovStorageState(context, expectedGeneration, signal);
    }
    return result;
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason;
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", closeOnAbort);
    await context.close().catch(() => undefined);
  }
}
