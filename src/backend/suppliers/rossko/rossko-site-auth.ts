import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { getStateFilePath } from "../../config.ts";
import type { RosskoSiteCredentials } from "../../types.ts";

export interface RosskoAuthCheckResult {
  authorized: boolean;
  details: string;
}

export const rosskoBusinessUrl = process.env.ROSSKO_BASE_URL?.trim() || "https://samara.rossko.ru/";

const authErrorPattern = /невер|неправ|ошиб|парол|логин|email|почт/i;
const rosskoNavigationTimeoutMs = Number(process.env.ROSSKO_NAVIGATION_TIMEOUT_MS ?? "7000");
const rosskoNavigationAttempts = Number(process.env.ROSSKO_NAVIGATION_ATTEMPTS ?? "2");
const rosskoPostCommitDelayMs = Number(process.env.ROSSKO_POST_COMMIT_DELAY_MS ?? "200");
const rosskoRetryDelayMs = Number(process.env.ROSSKO_RETRY_DELAY_MS ?? "250");
const rosskoSettledTimeoutMs = Number(process.env.ROSSKO_SETTLED_TIMEOUT_MS ?? "3000");
const rosskoSettledFallbackDelayMs = Number(process.env.ROSSKO_SETTLED_FALLBACK_DELAY_MS ?? "800");
const rosskoLoginFieldVisibleTimeoutMs = Number(process.env.ROSSKO_LOGIN_FIELD_VISIBLE_TIMEOUT_MS ?? "1200");
const rosskoStorageStatePath = getStateFilePath("rossko-storage-state.json");
const rosskoStateDir = dirname(rosskoStorageStatePath);

function ensureRosskoStateDir() {
  mkdirSync(rosskoStateDir, { recursive: true, mode: 0o700 });
}

function findBrowserExecutable(): string | undefined {
  const candidates = [
    process.env.ROSSKO_BROWSER_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter((value): value is string => Boolean(value));

  return candidates.find((candidate) => existsSync(candidate));
}

export function hasRosskoStorageState(): boolean {
  return existsSync(rosskoStorageStatePath);
}

export function clearRosskoStorageState(): void {
  if (existsSync(rosskoStorageStatePath)) {
    rmSync(rosskoStorageStatePath, { force: true });
  }
}

export function getRosskoAuthorizationSession(): string | null {
  if (!hasRosskoStorageState()) {
    return null;
  }

  try {
    const state = JSON.parse(readFileSync(rosskoStorageStatePath, "utf-8")) as {
      cookies?: Array<{ name?: string; value?: string }>;
    };
    return state.cookies?.find((cookie) => cookie.name === "auth")?.value || null;
  } catch {
    return null;
  }
}

export async function createRosskoBrowser() {
  const { chromium } = await import("playwright");

  return chromium.launch({
    headless: true,
    executablePath: findBrowserExecutable(),
  });
}

export async function saveRosskoStorageState(context: any): Promise<void> {
  ensureRosskoStateDir();
  await context.storageState({ path: rosskoStorageStatePath });
  chmodSync(rosskoStorageStatePath, 0o600);
}

export async function gotoRossko(page: any, url: string, label: string): Promise<void> {
  let lastError: unknown;
  const target = new URL(url);

  for (let attempt = 1; attempt <= rosskoNavigationAttempts; attempt += 1) {
    try {
      await page.goto(url, {
        waitUntil: "commit",
        timeout: rosskoNavigationTimeoutMs,
      });
      await page.waitForTimeout(rosskoPostCommitDelayMs);
      return;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);

      const currentUrl = page.url();

      if (message.includes("Timeout") && currentUrl !== "about:blank") {
        const current = new URL(currentUrl);

        if (current.host === target.host && current.pathname === target.pathname) {
          return;
        }
      }

      if (attempt < rosskoNavigationAttempts) {
        await page.waitForTimeout(rosskoRetryDelayMs * attempt);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Failed to open ${label}`);
}

export async function waitForRosskoSettled(page: any) {
  try {
    await page.waitForLoadState("networkidle", { timeout: rosskoSettledTimeoutMs });
  } catch {
    await page.waitForTimeout(rosskoSettledFallbackDelayMs);
  }
}

async function waitForVisibleRosskoField(field: any): Promise<boolean> {
  try {
    await field.waitFor({ state: "visible", timeout: rosskoLoginFieldVisibleTimeoutMs });
    return true;
  } catch {
    return false;
  }
}

export async function revealRosskoLoginForm(page: any) {
  let emailField = page.locator('input[name="auth[email]"]:visible').first();

  if ((await emailField.count()) > 0) {
    return emailField;
  }

  const loginDropdown = page.locator(".h-dropdown").filter({
    has: page.locator('form.signin-form input[name="auth[email]"]'),
  }).first();

  if ((await loginDropdown.count()) > 0) {
    const dropdownEmailField = loginDropdown.locator('input[name="auth[email]"]').first();

    try {
      await loginDropdown.hover();
    } catch {
      // Fall through to other activation strategies when hover is not available.
    }

    if (await waitForVisibleRosskoField(dropdownEmailField)) {
      return dropdownEmailField;
    }

    const loginTrigger = page.getByRole("link", { name: /вход/i }).first();

    if ((await loginTrigger.count()) > 0) {
      try {
        await loginTrigger.hover();
      } catch {
        // Fall through to direct dropdown activation.
      }

      if (await waitForVisibleRosskoField(dropdownEmailField)) {
        return dropdownEmailField;
      }
    }

    try {
      await loginDropdown.evaluate((node: Element) => {
        node.classList.add("h-dropdown--active");
      });
    } catch {
      // Fall through to link click when the dropdown cannot be toggled directly.
    }

    if (await waitForVisibleRosskoField(dropdownEmailField)) {
      return dropdownEmailField;
    }

    emailField = page.locator('input[name="auth[email]"]:visible').first();

    if ((await emailField.count()) > 0) {
      return emailField;
    }
  }

  const loginTrigger = page.getByRole("link", { name: /вход/i }).first();

  if ((await loginTrigger.count()) > 0) {
    await loginTrigger.click();
  }

  emailField = page.locator('input[name="auth[email]"]:visible').first();

  await waitForVisibleRosskoField(emailField);
  return emailField;
}

export async function getVisibleRosskoError(page: any): Promise<string | null> {
  const errorNode = page.locator(".signin-form__error:visible").first();

  if ((await errorNode.count()) === 0) {
    return null;
  }

  const text = (await errorNode.innerText()).trim();
  return text || null;
}

export async function performRosskoLogin(page: any, credentials: RosskoSiteCredentials): Promise<RosskoAuthCheckResult> {
  await gotoRossko(page, rosskoBusinessUrl, "страницу входа");

  const emailField = await revealRosskoLoginForm(page);
  const passwordField = page.locator('input[name="auth[password]"]:visible').first();

  if ((await emailField.count()) === 0 || (await passwordField.count()) === 0) {
    return {
      authorized: false,
      details: `Rossko login form was not found on ${rosskoBusinessUrl}`,
    };
  }

  await emailField.fill(credentials.login);
  await passwordField.fill(credentials.password);

  const form = page.locator("form").filter({ has: emailField }).first();
  const submitButton = form
    .locator('button[type="submit"], input[type="submit"], button')
    .filter({ hasText: /вход/i })
    .first();

  if ((await submitButton.count()) > 0) {
    await submitButton.click();
  } else {
    await passwordField.press("Enter");
  }

  await waitForRosskoSettled(page);

  const authFormStillVisible = (await page.locator('input[name="auth[email]"]:visible').count()) > 0;
  const bodyText = await page.locator("body").innerText();
  const rosskoErrorText = await getVisibleRosskoError(page);

  if (authFormStillVisible) {
    const message =
      rosskoErrorText ||
      (authErrorPattern.test(bodyText)
        ? "Rossko rejected the login or password"
        : "Rossko login form is still displayed after submit");
    return {
      authorized: false,
      details: message,
    };
  }

  return {
    authorized: true,
    details: "Rossko business account login was verified successfully",
  };
}

export async function verifyRosskoCredentials(credentials: RosskoSiteCredentials): Promise<RosskoAuthCheckResult> {
  const browser = await createRosskoBrowser();

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const result = await performRosskoLogin(page, credentials);

    if (result.authorized) {
      await saveRosskoStorageState(context);
    }

    return result;
  } finally {
    await browser.close();
  }
}
