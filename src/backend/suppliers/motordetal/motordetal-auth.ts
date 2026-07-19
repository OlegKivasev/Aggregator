import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getStateFilePath } from "../../config.ts";
import type { MotorDetalCredentials } from "../../types.ts";

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

export const motorDetalBaseUrl = process.env.MOTORDETAL_BASE_URL?.trim() || "https://sales.motordetal.ru/";
export const motorDetalApiUrl = new URL("/api/v1/", motorDetalBaseUrl).toString();

const motorDetalTokenStatePath = getStateFilePath("motordetal-token-state.json");
const motorDetalStateDir = dirname(motorDetalTokenStatePath);

function apiUrl(path: string): string {
  return new URL(path.replace(/^\//, ""), motorDetalApiUrl).toString();
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

async function readEnvelope<T>(response: Response): Promise<MotorDetalApiEnvelope<T>> {
  const payload = (await response.json().catch(() => ({}))) as MotorDetalApiEnvelope<T>;

  if (!response.ok || payload.success === false) {
    throw new Error(formatApiError(payload, `MotorDetal API returned HTTP ${response.status}`));
  }

  return payload;
}

function tokenStateFromAuth(data: MotorDetalAuthData | undefined): MotorDetalTokenState {
  const accessToken = data?.access?.token;
  const refreshToken = data?.refresh?.token;

  if (!accessToken || !refreshToken) {
    throw new Error("MotorDetal authorization did not return access and refresh tokens");
  }

  return { accessToken, refreshToken };
}

function saveMotorDetalTokenState(state: MotorDetalTokenState): void {
  mkdirSync(motorDetalStateDir, { recursive: true });
  writeFileSync(motorDetalTokenStatePath, JSON.stringify(state), { encoding: "utf-8", mode: 0o600 });
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
  if (hasMotorDetalTokenState()) {
    rmSync(motorDetalTokenStatePath, { force: true });
  }
}

async function refreshMotorDetalToken(state: MotorDetalTokenState): Promise<MotorDetalTokenState> {
  const response = await fetch(apiUrl("refresh/"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: state.refreshToken, info: "refresh" }),
  });
  const payload = await readEnvelope<MotorDetalAuthData>(response);
  const refreshed = tokenStateFromAuth(payload.data);
  saveMotorDetalTokenState(refreshed);
  return refreshed;
}

export async function getMotorDetalAccessToken(forceRefresh = false): Promise<string> {
  const state = loadMotorDetalTokenState();

  if (!state) {
    throw new Error("MotorDetal session is not configured");
  }

  if (!forceRefresh && isAccessTokenFresh(state.accessToken)) {
    return state.accessToken;
  }

  return (await refreshMotorDetalToken(state)).accessToken;
}

export async function motorDetalApiRequest<T>(path: string, searchParams?: URLSearchParams, signal?: AbortSignal): Promise<T> {
  const url = new URL(path.replace(/^\//, ""), motorDetalApiUrl);
  if (searchParams) {
    url.search = searchParams.toString();
  }

  const request = async (token: string) => fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  let response = await request(await getMotorDetalAccessToken());

  if (response.status === 401 || response.status === 403) {
    response = await request(await getMotorDetalAccessToken(true));
  }

  const payload = await readEnvelope<T>(response);
  if (payload.data === undefined) {
    throw new Error("MotorDetal API returned an empty response");
  }

  return payload.data;
}

export async function verifyMotorDetalCredentials(credentials: MotorDetalCredentials): Promise<MotorDetalAuthCheckResult> {
  try {
    const response = await fetch(apiUrl("sign-in/"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        login: credentials.login.trim().toLowerCase(),
        password: credentials.password,
        remember: true,
      }),
    });
    const payload = await readEnvelope<MotorDetalAuthData>(response);
    const state = tokenStateFromAuth(payload.data);
    saveMotorDetalTokenState(state);

    await motorDetalApiRequest<unknown>("init");
    return {
      authorized: true,
      details: "MotorDetal account login was verified successfully",
    };
  } catch (error) {
    clearMotorDetalTokenState();
    return {
      authorized: false,
      details: error instanceof Error ? error.message : "MotorDetal rejected authorization",
    };
  }
}
