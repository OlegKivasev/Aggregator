import { existsSync, readFileSync, rmSync } from "node:fs";
import { createBoundedAbortSignal } from "../../abort.ts";
import { getStateFilePath, motorDetalConfig, supplierMaxResponseBytes } from "../../config.ts";
import { writeJsonStateFileAtomic } from "../../session/state-file.ts";
import type { MotorDetalCredentials } from "../../types.ts";
import { SupplierAuthError, SupplierIntegrationError } from "../errors.ts";
import { readBoundedJsonResponse } from "../fetch-json.ts";

interface MotorDetalToken {
  token?: string;
  info?: string | null;
}

interface MotorDetalAuthData {
  access?: MotorDetalToken;
  refresh?: MotorDetalToken;
}

interface MotorDetalApiEnvelope<T> {
  success?: boolean;
  message?: string;
  errors?: unknown;
  data?: T;
}

export interface MotorDetalTokenState {
  accessToken: string;
  refreshToken: string;
}

export interface MotorDetalAuthCheckResult {
  authorized: boolean;
  details: string;
}

export const motorDetalBaseUrl = motorDetalConfig.baseUrl;
export const motorDetalApiUrl = new URL("/api/v1/", motorDetalBaseUrl).toString();

const motorDetalTokenStatePath = getStateFilePath("motordetal-token-state.json");
let tokenStateGeneration = 0;

function apiUrl(path: string): string {
  return new URL(path.replace(/^\//, ""), motorDetalApiUrl).toString();
}

async function requestMotorDetal<T>(
  input: string | URL,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<{ status: number; ok: boolean; payload: MotorDetalApiEnvelope<T> }> {
  const parentSignal = signal ?? new AbortController().signal;
  const requestSignal = createBoundedAbortSignal(parentSignal, motorDetalConfig.requestTimeoutMs, "MotorDetal API request timed out");
  try {
    let response: Response;
    try {
      response = await fetch(input, { ...init, signal: requestSignal.signal, redirect: "error" });
    } catch (error) {
      if (requestSignal.signal.aborted) {
        throw requestSignal.signal.reason;
      }
      throw new SupplierIntegrationError("MotorDetal API request failed", { cause: error });
    }
    if (response.status === 401 || response.status === 403) {
      return { status: response.status, ok: false, payload: {} };
    }
    const payload = await readBoundedJsonResponse(response, supplierMaxResponseBytes, "MotorDetal API") as MotorDetalApiEnvelope<T>;
    return { status: response.status, ok: response.ok, payload };
  } finally {
    requestSignal.dispose();
  }
}

function formatApiError(payload: MotorDetalApiEnvelope<unknown>, fallback: string): string {
  if (payload.message?.trim()) {
    return payload.message.trim();
  }

  if (Array.isArray(payload.errors)) {
    const errors = payload.errors.map(String).filter(Boolean).join("; ");
    if (errors) {
      return errors;
    }
  }

  return fallback;
}

function isMotorDetalAuthorizationFailure(payload: MotorDetalApiEnvelope<unknown>): boolean {
  const details = [
    payload.message,
    ...(Array.isArray(payload.errors) ? payload.errors.map(String) : []),
  ].filter((value): value is string => typeof value === "string").join(" ");
  return /authoriz|unauthor|forbidden|session|token|доступ|авторизац|сесси|токен/i.test(details);
}

function readEnvelope<T>(
  response: { status: number; ok: boolean; payload: MotorDetalApiEnvelope<T> },
  failedEnvelopeMeansAuthorization = false,
): MotorDetalApiEnvelope<T> {
  if (
    response.ok &&
    response.payload.success === false &&
    (failedEnvelopeMeansAuthorization || isMotorDetalAuthorizationFailure(response.payload))
  ) {
    throw new SupplierAuthError("MotorDetal session has expired");
  }
  if (!response.ok || response.payload.success === false) {
    throw new SupplierIntegrationError(formatApiError(response.payload, `MotorDetal API returned HTTP ${response.status}`));
  }

  return response.payload;
}

function tokenStateFromAuth(data: MotorDetalAuthData | undefined): MotorDetalTokenState {
  const accessToken = data?.access?.token;
  const refreshToken = data?.refresh?.token;

  if (!accessToken || !refreshToken) {
    throw new SupplierIntegrationError("MotorDetal authorization did not return access and refresh tokens");
  }

  return { accessToken, refreshToken };
}

function saveMotorDetalTokenState(state: MotorDetalTokenState, expectedGeneration: number): void {
  writeJsonStateFileAtomic(
    motorDetalTokenStatePath,
    state,
    () => tokenStateGeneration === expectedGeneration,
  );
}

function isAccessTokenFresh(token: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf-8")) as { exp?: number };
    return typeof payload.exp === "number" && payload.exp * 1000 > Date.now() + 60_000;
  } catch {
    return false;
  }
}

export function hasMotorDetalTokenState(): boolean {
  return existsSync(motorDetalTokenStatePath);
}

export function loadMotorDetalTokenState(): MotorDetalTokenState | null {
  if (!hasMotorDetalTokenState()) {
    return null;
  }

  try {
    const state = JSON.parse(readFileSync(motorDetalTokenStatePath, "utf-8")) as Partial<MotorDetalTokenState>;
    return state.accessToken && state.refreshToken
      ? { accessToken: state.accessToken, refreshToken: state.refreshToken }
      : null;
  } catch {
    return null;
  }
}

export function clearMotorDetalTokenState(): void {
  tokenStateGeneration += 1;
  if (hasMotorDetalTokenState()) {
    rmSync(motorDetalTokenStatePath, { force: true });
  }
}

async function refreshMotorDetalToken(state: MotorDetalTokenState, signal?: AbortSignal): Promise<MotorDetalTokenState> {
  const expectedGeneration = tokenStateGeneration;
  const response = await requestMotorDetal<MotorDetalAuthData>(apiUrl("refresh/"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: state.refreshToken, info: "refresh" }),
  }, signal);
  if (response.status === 401 || response.status === 403) {
    throw new SupplierAuthError("MotorDetal session has expired");
  }
  const payload = readEnvelope(response, true);
  const refreshed = tokenStateFromAuth(payload.data);
  signal?.throwIfAborted();
  saveMotorDetalTokenState(refreshed, expectedGeneration);
  return refreshed;
}

export async function getMotorDetalAccessToken(forceRefresh = false, signal?: AbortSignal): Promise<string> {
  const state = loadMotorDetalTokenState();

  if (!state) {
    throw new SupplierAuthError("MotorDetal session is not configured");
  }

  if (!forceRefresh && isAccessTokenFresh(state.accessToken)) {
    return state.accessToken;
  }

  return (await refreshMotorDetalToken(state, signal)).accessToken;
}

export async function motorDetalApiRequest<T>(path: string, searchParams?: URLSearchParams, signal?: AbortSignal): Promise<T> {
  const url = new URL(path.replace(/^\//, ""), motorDetalApiUrl);
  if (searchParams) {
    url.search = searchParams.toString();
  }

  const request = async (token: string) => requestMotorDetal<T>(url, {
    headers: { Authorization: `Bearer ${token}` },
  }, signal);
  let response = await request(await getMotorDetalAccessToken(false, signal));

  if (response.status === 401 || response.status === 403) {
    response = await request(await getMotorDetalAccessToken(true, signal));
  }

  if (response.status === 401 || response.status === 403) {
    throw new SupplierAuthError("MotorDetal session has expired");
  }

  const payload = readEnvelope(response);
  if (payload.data === undefined) {
    throw new SupplierIntegrationError("MotorDetal API returned an empty response");
  }

  return payload.data;
}

export async function verifyMotorDetalCredentials(
  credentials: MotorDetalCredentials,
  signal?: AbortSignal,
): Promise<MotorDetalAuthCheckResult> {
  tokenStateGeneration += 1;
  const expectedGeneration = tokenStateGeneration;
  try {
    const response = await requestMotorDetal<MotorDetalAuthData>(apiUrl("sign-in/"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        login: credentials.login.trim().toLowerCase(),
        password: credentials.password,
        remember: true,
      }),
    }, signal);
    if (response.status === 401 || response.status === 403) {
      throw new SupplierAuthError("MotorDetal rejected login or password");
    }
    const payload = response.payload;
    if (!response.ok) {
      throw new SupplierIntegrationError(formatApiError(payload, `MotorDetal API returned HTTP ${response.status}`));
    }
    if (payload.success === false) {
      throw new SupplierAuthError("MotorDetal rejected login or password");
    }
    const state = tokenStateFromAuth(payload.data);
    const initialization = await requestMotorDetal<unknown>(apiUrl("init"), {
      headers: { Authorization: `Bearer ${state.accessToken}` },
    }, signal);
    if (initialization.status === 401 || initialization.status === 403) {
      throw new SupplierAuthError("MotorDetal rejected the authorized session");
    }
    readEnvelope(initialization);
    signal?.throwIfAborted();
    saveMotorDetalTokenState(state, expectedGeneration);
    return {
      authorized: true,
      details: "MotorDetal account login was verified successfully",
    };
  } catch (error) {
    if (error instanceof SupplierAuthError) {
      return {
        authorized: false,
        details: "MotorDetal rejected login or password",
      };
    }
    throw error;
  }
}
