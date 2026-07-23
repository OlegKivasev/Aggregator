import { getArmtekApiConfig } from "./config.ts";
import { SupplierSessionManager } from "./session/session-manager.ts";
import { ArmtekApiAdapter, verifyArmtekCredentials } from "./suppliers/armtek/armtek-api-adapter.ts";
import { clearArmtekApiAccountState } from "./suppliers/armtek/armtek-api-account-state.ts";
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
import { RosskoSiteApiAdapter } from "./suppliers/rossko/rossko-site-api-adapter.ts";
import {
  clearRosskoStorageState,
  hasRosskoStorageState,
  verifyRosskoCredentials,
} from "./suppliers/rossko/rossko-site-auth.ts";
import {
  clearStpartsStorageState,
  hasStpartsStorageState,
  validateStpartsStoredSession,
  verifyStpartsCredentials,
} from "./suppliers/stparts/stparts-site-auth.ts";
import { StpartsApiAdapter } from "./suppliers/stparts/stparts-api-adapter.ts";
import type { SupplierAdapter } from "./suppliers/supplier-adapter.ts";
import { SupplierAuthError, SupplierTimeoutError } from "./suppliers/errors.ts";
import { MladovWebAdapter } from "./suppliers/mladov/mladov-web-adapter.ts";
import { clearMladovStorageState, closeMladovBrowser, hasMladovStorageState, verifyMladovCredentials } from "./suppliers/mladov/mladov-site-auth.ts";
import type { ArmtekCredentials, MladovCredentials, MotorDetalCredentials, PartKomCredentials, RosskoSiteCredentials, SearchQuery, SearchStreamEvent, StpartsCredentials, SupplierId, SupplierSessionValidationResult } from "./types.ts";

const sessionManager = new SupplierSessionManager();
const rosskoAdapter = new RosskoSiteApiAdapter();
const armtekAdapter = new ArmtekApiAdapter();
const partKomAdapter = new PartKomApiAdapter();
const stpartsAdapter = new StpartsApiAdapter();
const motorDetalAdapter = new MotorDetalApiAdapter();
const mladovAdapter = new MladovWebAdapter();

function getSearchAdapters(query: SearchQuery): SupplierAdapter[] {
  const adapters = [rosskoAdapter, armtekAdapter, partKomAdapter, stpartsAdapter, motorDetalAdapter, mladovAdapter];

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
  await closeMladovBrowser();
}

export async function authorizeRossko(credentials: RosskoSiteCredentials) {
  const result = await verifyRosskoCredentials(credentials);

  if (!result.authorized) {
    clearRosskoStorageState();
    return sessionManager.markUnauthorized("rossko", result.details);
  }

  return sessionManager.markAuthorized("rossko", result.details);
}

export function logoutRossko() {
  clearRosskoStorageState();
  return sessionManager.markUnauthorized("rossko");
}

export async function authorizeArmtek(credentials: ArmtekCredentials) {
  const details = await verifyArmtekCredentials(credentials);

  sessionManager.setArmtekCredentials(credentials);
  return sessionManager.markAuthorized("armtek", details);
}

export function logoutArmtek() {
  sessionManager.clearArmtekCredentials();
  clearArmtekApiAccountState();
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

const supplierLogout = new Map<SupplierId, () => unknown>([
  ["rossko", logoutRossko],
  ["armtek", logoutArmtek],
  ["part-kom", logoutPartKom],
  ["stparts", logoutStparts],
  ["motordetal", logoutMotorDetal],
  ["mladov", logoutMladov],
]);

function disconnectSupplier(supplier: SupplierId): void {
  supplierLogout.get(supplier)?.();
}

async function validateSupplierSession(
  adapter: SupplierAdapter,
  article: string,
  signal: AbortSignal,
): Promise<SupplierSessionValidationResult> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", forwardAbort, { once: true });
  const timeoutId = setTimeout(
    () => controller.abort(new SupplierTimeoutError(`Validation timed out after ${adapter.timeoutMs}ms`)),
    adapter.timeoutMs,
  );

  try {
    const session = await adapter.ensureSession(sessionManager);
    if (!session.authorized) {
      throw new SupplierAuthError();
    }

    if (adapter.id === "stparts") {
      if (!await validateStpartsStoredSession(controller.signal)) {
        throw new SupplierAuthError("STParts session has expired");
      }
    } else {
      await adapter.search(
        { article, suppliers: [adapter.id] },
        { signal: controller.signal, timeoutMs: adapter.timeoutMs },
        () => undefined,
        sessionManager,
      );
    }
    sessionManager.markChecked(adapter.id);
    return { supplier: adapter.id, status: "connected" };
  } catch (error) {
    if (error instanceof SupplierAuthError) {
      disconnectSupplier(adapter.id);
      return { supplier: adapter.id, status: "expired" };
    }

    if (signal.aborted) {
      throw signal.reason;
    }

    return { supplier: adapter.id, status: "error" };
  } finally {
    clearTimeout(timeoutId);
    signal.removeEventListener("abort", forwardAbort);
  }
}

export async function validateSupplierSessions(
  article: string,
  suppliers: SupplierId[],
  signal: AbortSignal,
): Promise<{ results: SupplierSessionValidationResult[]; sessions: ReturnType<typeof listSupplierSessions> }> {
  const adapters = getSearchAdapters({ article, suppliers });
  const results = await Promise.all(adapters.map((adapter) => validateSupplierSession(adapter, article, signal)));
  return { results, sessions: listSupplierSessions() };
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
        onAuthError: () => disconnectSupplier(adapter.id),
      }),
    ),
  );

  if (signal.aborted) {
    return;
  }

  emit({
    type: "search_completed",
    article: query.article,
  });
}
