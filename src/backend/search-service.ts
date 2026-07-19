import { getArmtekApiConfig, getRosskoApiConfig } from "./config.ts";
import { SupplierSessionManager } from "./session/session-manager.ts";
import { ArmtekApiAdapter, verifyArmtekCredentials } from "./suppliers/armtek/armtek-api-adapter.ts";
import {
  clearArmtekStorageState,
  closeArmtekBrowser,
  hasArmtekStorageState,
  verifyArmtekEtpCredentials,
} from "./suppliers/armtek/armtek-site-auth.ts";
import { runSupplierSearch } from "./suppliers/run-supplier-search.ts";
import { MotorDetalApiAdapter } from "./suppliers/motordetal/motordetal-api-adapter.ts";
import {
  clearMotorDetalTokenState,
  hasMotorDetalTokenState,
  verifyMotorDetalCredentials,
} from "./suppliers/motordetal/motordetal-auth.ts";
import {
  clearPartKomStorageState,
  hasPartKomStorageState,
  verifyPartKomCredentials,
} from "./suppliers/part-kom/part-kom-site-auth.ts";
import { PartKomApiAdapter } from "./suppliers/part-kom/part-kom-api-adapter.ts";
import { RosskoApiAdapter } from "./suppliers/rossko/rossko-api-adapter.ts";
import { RosskoMockAdapter } from "./suppliers/rossko/rossko-mock-adapter.ts";
import { RosskoSiteApiAdapter } from "./suppliers/rossko/rossko-site-api-adapter.ts";
import {
  clearRosskoStorageState,
  hasRosskoStorageState,
  verifyRosskoCredentials,
} from "./suppliers/rossko/rossko-site-auth.ts";
import {
  clearStpartsStorageState,
  hasStpartsStorageState,
  verifyStpartsCredentials,
} from "./suppliers/stparts/stparts-site-auth.ts";
import { StpartsApiAdapter } from "./suppliers/stparts/stparts-api-adapter.ts";
import type { SupplierAdapter } from "./suppliers/supplier-adapter.ts";
import { MladovWebAdapter } from "./suppliers/mladov/mladov-web-adapter.ts";
import { clearMladovStorageState, closeMladovBrowser, hasMladovStorageState, verifyMladovCredentials } from "./suppliers/mladov/mladov-site-auth.ts";
import type { ArmtekCredentials, MladovCredentials, MotorDetalCredentials, PartKomCredentials, RosskoSiteCredentials, SearchQuery, SearchStreamEvent, StpartsCredentials } from "./types.ts";

const sessionManager = new SupplierSessionManager();
const apiAdapters: SupplierAdapter[] = [new RosskoApiAdapter()];
const webAdapters: SupplierAdapter[] = [new RosskoSiteApiAdapter()];
const armtekAdapter = new ArmtekApiAdapter();
const partKomAdapter = new PartKomApiAdapter();
const stpartsAdapter = new StpartsApiAdapter();
const motorDetalAdapter = new MotorDetalApiAdapter();
const mladovAdapter = new MladovWebAdapter();

function getRosskoSearchAdapters(): SupplierAdapter[] {
  if (process.env.ROSSKO_USE_STUB === "1") {
    return [new RosskoMockAdapter()];
  }

  if (hasRosskoStorageState() || sessionManager.getRosskoCredentials()) {
    return webAdapters;
  }

  if (getRosskoApiConfig()) {
    return apiAdapters;
  }

  return apiAdapters;
}

function getSearchAdapters(query: SearchQuery): SupplierAdapter[] {
  const adapters = [...getRosskoSearchAdapters(), armtekAdapter, partKomAdapter, stpartsAdapter, motorDetalAdapter, mladovAdapter];

  if (!query.suppliers) {
    return adapters;
  }

  return adapters.filter((adapter) => query.suppliers?.includes(adapter.id));
}

function bootstrapPersistedSessions() {
  if (hasRosskoStorageState()) {
    sessionManager.markAuthorized("rossko");
  }

  if (getArmtekApiConfig()) {
    sessionManager.markAuthorized("armtek", "Armtek API credentials are configured in environment");
  }

  if (hasArmtekStorageState()) {
    sessionManager.markAuthorized("armtek", "Armtek ETP stored session is available");
  }

  if (hasPartKomStorageState()) {
    sessionManager.markAuthorized("part-kom", "Part-Kom stored session is available");
  }

  if (hasStpartsStorageState()) {
    sessionManager.markAuthorized("stparts", "STParts stored session is available");
  }

  if (hasMotorDetalTokenState()) {
    sessionManager.markAuthorized("motordetal", "MotorDetal stored session is available");
  }

  if (hasMladovStorageState()) {
    sessionManager.markAuthorized("mladov", "Сохраненная сессия Механик Ладов доступна");
  }
}

bootstrapPersistedSessions();

export function listSupplierSessions() {
  return sessionManager.getAllSessions();
}

export async function shutdownSearchService(): Promise<void> {
  await Promise.all([closeArmtekBrowser(), closeMladovBrowser()]);
}

export async function authorizeRossko(credentials: RosskoSiteCredentials) {
  const result = await verifyRosskoCredentials(credentials);

  if (!result.authorized) {
    sessionManager.clearRosskoCredentials();
    clearRosskoStorageState();
    return sessionManager.markUnauthorized("rossko", result.details);
  }

  sessionManager.setRosskoCredentials(credentials);
  return sessionManager.markAuthorized("rossko", result.details);
}

export function logoutRossko() {
  sessionManager.clearRosskoCredentials();
  clearRosskoStorageState();
  return sessionManager.markUnauthorized("rossko");
}

export async function authorizeArmtek(credentials: ArmtekCredentials) {
  let details: string;

  try {
    details = await verifyArmtekCredentials(credentials);
  } catch {
    const etpResult = await verifyArmtekEtpCredentials(credentials);

    if (!etpResult.authorized) {
      sessionManager.clearArmtekCredentials();
      clearArmtekStorageState();
      return sessionManager.markUnauthorized("armtek", etpResult.details);
    }

    details = etpResult.details;
  }

  sessionManager.setArmtekCredentials(credentials);
  return sessionManager.markAuthorized("armtek", details);
}

export function logoutArmtek() {
  sessionManager.clearArmtekCredentials();
  clearArmtekStorageState();
  return sessionManager.markUnauthorized("armtek");
}

export async function authorizePartKom(credentials: PartKomCredentials) {
  const result = await verifyPartKomCredentials(credentials);

  if (!result.authorized) {
    clearPartKomStorageState();
    return sessionManager.markUnauthorized("part-kom", result.details);
  }

  return sessionManager.markAuthorized("part-kom", result.details);
}

export function logoutPartKom() {
  clearPartKomStorageState();
  return sessionManager.markUnauthorized("part-kom");
}

export async function authorizeStparts(credentials: StpartsCredentials) {
  const result = await verifyStpartsCredentials(credentials);

  if (!result.authorized) {
    clearStpartsStorageState();
    return sessionManager.markUnauthorized("stparts", result.details);
  }

  return sessionManager.markAuthorized("stparts", result.details);
}

export function logoutStparts() {
  clearStpartsStorageState();
  return sessionManager.markUnauthorized("stparts");
}

export async function authorizeMotorDetal(credentials: MotorDetalCredentials) {
  const result = await verifyMotorDetalCredentials(credentials);

  if (!result.authorized) {
    sessionManager.clearMotorDetalCredentials();
    clearMotorDetalTokenState();
    return sessionManager.markUnauthorized("motordetal", result.details);
  }

  sessionManager.setMotorDetalCredentials(credentials);
  return sessionManager.markAuthorized("motordetal", result.details);
}

export function logoutMotorDetal() {
  sessionManager.clearMotorDetalCredentials();
  clearMotorDetalTokenState();
  return sessionManager.markUnauthorized("motordetal");
}

export async function authorizeMladov(credentials: MladovCredentials) {
  const result = await verifyMladovCredentials(credentials);
  if (!result.authorized) {
    sessionManager.clearMladovCredentials();
    clearMladovStorageState();
    return sessionManager.markUnauthorized("mladov", result.details);
  }
  sessionManager.setMladovCredentials(credentials);
  return sessionManager.markAuthorized("mladov", result.details);
}

export function logoutMladov() {
  sessionManager.clearMladovCredentials();
  clearMladovStorageState();
  return sessionManager.markUnauthorized("mladov");
}

export async function streamSearch(
  query: SearchQuery,
  emit: (event: SearchStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const currentAdapters = getSearchAdapters(query);

  emit({
    type: "search_started",
    article: query.article,
    suppliers: currentAdapters.map((adapter) => adapter.id),
  });

  await Promise.all(
    currentAdapters.map((adapter) =>
      runSupplierSearch({
        adapter,
        sessionManager,
        query,
        signal,
        emit,
      }),
    ),
  );

  emit({
    type: "search_completed",
    article: query.article,
  });
}
