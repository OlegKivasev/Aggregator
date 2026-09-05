import { existsSync, readFileSync, rmSync } from "node:fs";
import { getStateFilePath, rosskoConfig, supplierMaxResponseBytes } from "../../config.ts";
import { writeJsonStateFileAtomic } from "../../session/state-file.ts";
import type { RosskoSiteCredentials } from "../../types.ts";
import { SupplierIntegrationError } from "../errors.ts";

export interface RosskoAuthCheckResult {
  authorized: boolean;
  details: string;
  failure?: "authorization" | "integration";
}

export const rosskoBusinessUrl = rosskoConfig.businessUrl;

const authErrorPattern = /невер|неправ|ошиб|парол|логин|email|почт/i;
const rosskoNavigationTimeoutMs = rosskoConfig.navigationTimeoutMs;
const rosskoNavigationAttempts = rosskoConfig.navigationAttempts;
const rosskoPostCommitDelayMs = rosskoConfig.postCommitDelayMs;
const rosskoRetryDelayMs = rosskoConfig.retryDelayMs;
const rosskoSettledTimeoutMs = rosskoConfig.settledTimeoutMs;
const rosskoSettledFallbackDelayMs = rosskoConfig.settledFallbackDelayMs;
const rosskoLoginFieldVisibleTimeoutMs = rosskoConfig.loginFieldVisibleTimeoutMs;
const rosskoAuthCookieWaitTimeoutMs = rosskoConfig.authCookieWaitTimeoutMs;
const rosskoAuthCookiePollIntervalMs = rosskoConfig.authCookiePollIntervalMs;
const rosskoAuthResponseTimeoutMs = rosskoConfig.authResponseTimeoutMs;
const rosskoStorageStatePath = getStateFilePath("rossko-storage-state.json");
let storageStateGeneration = 0;

function findBrowserExecutable(): string | undefined {
  const candidates = [
    rosskoConfig.browserPath,
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
  storageStateGeneration += 1;
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

export async function saveRosskoStorageState(
  context: any,
  expectedGeneration: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const state = await context.storageState();
  signal?.throwIfAborted();
  writeJsonStateFileAtomic(
    rosskoStorageStatePath,
    state,
    () => storageStateGeneration === expectedGeneration && !signal?.aborted,
  );
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

async function hasRosskoAuthCookie(context: any): Promise<boolean> {
  const cookies = await context.cookies(rosskoBusinessUrl);
  return cookies.some((cookie: { name?: string; value?: string }) => cookie.name === "auth" && Boolean(cookie.value));
}

async function getRosskoAuthCookie(context: any): Promise<string | null> {
  const cookies = await context.cookies(rosskoBusinessUrl);
  return cookies.find((cookie: { name?: string; value?: string }) => cookie.name === "auth")?.value || null;
}

function rosskoDeliverySchemaUrl(): URL {
  const businessUrl = new URL(rosskoBusinessUrl);
  const city = businessUrl.hostname.split(".")[0];
  const url = new URL("/api/Delivery/GetDeliverySchema", `${businessUrl.protocol}//${city}-productcard.rossko.ru/`);
  url.searchParams.set("newCart", "true");
  return url;
}

interface RosskoDeliverySessionInspection {
  ready: boolean;
  addressesCount: number | null;
  typesCount: number | null;
}

export function inspectRosskoDeliverySession(payload: unknown): RosskoDeliverySessionInspection {
  if (!payload || typeof payload !== "object") {
    return { ready: false, addressesCount: null, typesCount: null };
  }

  const delivery = payload as {
    addresses?: unknown;
    types?: unknown;
  };
  const addressesCount = Array.isArray(delivery.addresses) ? delivery.addresses.length : null;
  const typesCount = Array.isArray(delivery.types) ? delivery.types.length : null;
  const hasAddress = Array.isArray(delivery.addresses) && delivery.addresses.some((item) => (
    item !== null &&
    typeof item === "object" &&
    typeof (item as { pointGuid?: unknown }).pointGuid === "string" &&
    Boolean((item as { pointGuid: string }).pointGuid.trim())
  ));
  const hasDeliveryType = Array.isArray(delivery.types) && delivery.types.some((item) => (
    item !== null &&
    typeof item === "object" &&
    typeof (item as { value?: unknown }).value === "string" &&
    Boolean((item as { value: string }).value.trim())
  ));

  return {
    ready: hasAddress && hasDeliveryType,
    addressesCount,
    typesCount,
  };
}

export async function initializeRosskoAuthenticatedSession(page: any): Promise<RosskoAuthCheckResult> {
  await gotoRossko(page, rosskoBusinessUrl, "главную страницу после входа");
  await waitForRosskoSettled(page);

  const context = page.context();
  const authorizationSession = await getRosskoAuthCookie(context);
  if (!authorizationSession) {
    return {
      authorized: false,
      details: "Rossko auth cookie disappeared before delivery settings initialization",
      failure: "authorization",
    };
  }

  const deliveryUrl = rosskoDeliverySchemaUrl();
  let lastInspection: RosskoDeliverySessionInspection = {
    ready: false,
    addressesCount: null,
    typesCount: null,
  };

  for (let attempt = 1; attempt <= rosskoConfig.apiRequestAttempts; attempt += 1) {
    const response = await context.request.get(deliveryUrl.toString(), {
      failOnStatusCode: false,
      timeout: rosskoConfig.apiRequestTimeoutMs,
      headers: {
        Accept: "application/json, text/plain, */*",
        "Authorization-Domain": new URL(rosskoBusinessUrl).origin,
        "Authorization-Session": authorizationSession,
        Referer: rosskoBusinessUrl,
        Source: "frontend",
      },
    });

    try {
      const status = response.status();
      if (status === 401 || status === 403) {
        return {
          authorized: false,
          details: `Rossko rejected the initialized browser session with HTTP ${status}`,
          failure: "authorization",
        };
      }
      if (status < 200 || status >= 300) {
        return {
          authorized: false,
          details: `Rossko delivery settings initialization returned HTTP ${status}`,
          failure: "integration",
        };
      }

      const contentType = response.headers()["content-type"] || "";
      if (!/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i.test(contentType)) {
        return {
          authorized: false,
          details: "Rossko delivery settings initialization returned a non-JSON response",
          failure: "integration",
        };
      }

      const body = await response.body();
      if (body.byteLength > supplierMaxResponseBytes) {
        return {
          authorized: false,
          details: "Rossko delivery settings initialization response was too large",
          failure: "integration",
        };
      }

      let payload: unknown;
      try {
        payload = JSON.parse(body.toString("utf-8"));
      } catch {
        return {
          authorized: false,
          details: "Rossko delivery settings initialization returned invalid JSON",
          failure: "integration",
        };
      }

      lastInspection = inspectRosskoDeliverySession(payload);
      if (lastInspection.ready) {
        return {
          authorized: true,
          details: "Rossko business account login and delivery settings were verified successfully",
        };
      }
    } finally {
      await response.dispose();
    }

    if (attempt < rosskoConfig.apiRequestAttempts) {
      await page.waitForTimeout(rosskoConfig.retryDelayMs * attempt);
    }
  }

  return {
    authorized: false,
    details: `Rossko accepted the login but did not initialize a delivery address (addresses=${lastInspection.addressesCount ?? "invalid"}, types=${lastInspection.typesCount ?? "invalid"})`,
    failure: "integration",
  };
}

async function waitForRosskoAuthCookie(page: any): Promise<boolean> {
  const deadline = Date.now() + rosskoAuthCookieWaitTimeoutMs;
  const context = page.context();

  while (Date.now() < deadline) {
    if (await hasRosskoAuthCookie(context)) {
      return true;
    }

    const rosskoErrorText = await getVisibleRosskoError(page);
    if (rosskoErrorText) {
      return false;
    }

    await page.waitForTimeout(rosskoAuthCookiePollIntervalMs);
  }

  return hasRosskoAuthCookie(context);
}

async function waitForRosskoAuthResponse(page: any): Promise<RosskoAuthCheckResult | null> {
  try {
    const response = await page.waitForResponse(async (candidate: any) => {
      if (candidate.request().method() !== "POST") {
        return false;
      }

      const url = new URL(candidate.url());
      if (url.origin !== new URL(rosskoBusinessUrl).origin || url.pathname !== "/utils/") {
        return false;
      }

      const postData = candidate.request().postData() || "";
      return postData.includes("action=auth") && postData.includes("type=header");
    }, { timeout: rosskoAuthResponseTimeoutMs });

    const payload = await response.json() as { err?: boolean; msg?: string; location?: string };

    if (payload.err) {
      return {
        authorized: false,
        details: payload.msg?.trim() || "Rossko rejected the login or password",
        failure: "authorization",
      };
    }

    return {
      authorized: true,
      details: payload.location ? "Rossko login redirect was returned" : "Rossko login was accepted",
    };
  } catch {
    return null;
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
    try {
      await loginTrigger.hover();
    } catch {
      // The form can also be opened by directly activating its hidden container.
    }
  }

  emailField = page.locator('input[name="auth[email]"]:visible').first();

  if (await waitForVisibleRosskoField(emailField)) {
    return emailField;
  }

  const hiddenEmailField = page.locator('input[name="auth[email]"]').first();
  if ((await hiddenEmailField.count()) > 0) {
    await hiddenEmailField.evaluate((field: Element) => {
      let container = field.closest("form")?.parentElement;

      while (container && getComputedStyle(container).display === "none") {
        container.style.display = "block";
        container.style.visibility = "visible";
        container = container.parentElement;
      }
    });
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
      failure: "integration",
    };
  }

  await emailField.fill(credentials.login);
  await passwordField.fill(credentials.password);

  const form = page.locator("form").filter({ has: emailField }).first();
  const submitButton = form
    .locator('button[type="submit"], input[type="submit"], button')
    .filter({ hasText: /вход/i })
    .first();

  const authResponsePromise = waitForRosskoAuthResponse(page);

  if ((await submitButton.count()) > 0) {
    await submitButton.click();
  } else {
    await passwordField.press("Enter");
  }

  await waitForRosskoSettled(page);

  const authResponse = await authResponsePromise;

  if (authResponse && !authResponse.authorized) {
    return authResponse;
  }

  if (await waitForRosskoAuthCookie(page)) {
    return initializeRosskoAuthenticatedSession(page);
  }

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
      failure: rosskoErrorText || authErrorPattern.test(bodyText) ? "authorization" : "integration",
    };
  }

  return {
    authorized: false,
    details: authFormStillVisible
      ? "Rossko login result could not be confirmed"
      : "Rossko auth cookie was not created after submit",
    failure: "integration",
  };
}

export async function verifyRosskoCredentials(
  credentials: RosskoSiteCredentials,
  signal?: AbortSignal,
): Promise<RosskoAuthCheckResult> {
  storageStateGeneration += 1;
  const expectedGeneration = storageStateGeneration;
  let browser: any;
  const closeOnAbort = () => browser?.close().catch(() => undefined);

  try {
    signal?.throwIfAborted();
    const browserPromise = createRosskoBrowser();
    if (signal) {
      browser = await new Promise<any>((resolve, reject) => {
        const abortLaunch = () => reject(signal.reason);
        signal.addEventListener("abort", abortLaunch, { once: true });
        browserPromise.then(
          (launchedBrowser) => {
            signal.removeEventListener("abort", abortLaunch);
            if (signal.aborted) {
              launchedBrowser.close().catch(() => undefined);
              reject(signal.reason);
              return;
            }
            resolve(launchedBrowser);
          },
          (error) => {
            signal.removeEventListener("abort", abortLaunch);
            reject(error);
          },
        );
      });
    } else {
      browser = await browserPromise;
    }
    signal?.addEventListener("abort", closeOnAbort, { once: true });
    signal?.throwIfAborted();
    const context = await browser.newContext();
    const page = await context.newPage();
    const result = await performRosskoLogin(page, credentials);

    if (result.authorized) {
      signal?.throwIfAborted();
      await saveRosskoStorageState(context, expectedGeneration, signal);
    }

    return result;
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason;
    }
    if (error instanceof SupplierIntegrationError) {
      throw error;
    }
    throw new SupplierIntegrationError("Rossko authorization check failed", { cause: error });
  } finally {
    signal?.removeEventListener("abort", closeOnAbort);
    if (browser) {
      // Cleanup failure must not replace the authorization, timeout, or abort result.
      await browser.close().catch(() => undefined);
    }
  }
}
