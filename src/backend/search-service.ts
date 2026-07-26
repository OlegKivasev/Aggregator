import { SearchApplicationService } from "./application/search-application-service.ts";
import { SupplierSessionService } from "./application/supplier-session-service.ts";
import { getArmtekApiConfig, getStateFilePath, getStpartsApiConfig, supplierCredentialsEncryptionKey } from "./config.ts";
import { EncryptedSupplierCredentialStore } from "./session/encrypted-credential-store.ts";
import { SupplierSessionManager } from "./session/session-manager.ts";
import { clearArmtekApiAccountState } from "./suppliers/armtek/armtek-api-account-state.ts";
import { ArmtekApiAdapter, verifyArmtekCredentials } from "./suppliers/armtek/armtek-api-adapter.ts";
import { MladovWebAdapter } from "./suppliers/mladov/mladov-web-adapter.ts";
import {
  clearMladovStorageState,
  closeMladovBrowser,
  hasMladovStorageState,
  verifyMladovCredentials,
} from "./suppliers/mladov/mladov-site-auth.ts";
import { MotorDetalApiAdapter } from "./suppliers/motordetal/motordetal-api-adapter.ts";
import {
  clearMotorDetalTokenState,
  hasMotorDetalTokenState,
  verifyMotorDetalCredentials,
} from "./suppliers/motordetal/motordetal-auth.ts";
import { PartKomApiAdapter, verifyPartKomApiCredentials } from "./suppliers/part-kom/part-kom-api-adapter.ts";
import { closeRosskoHttpAgent, RosskoSiteApiAdapter } from "./suppliers/rossko/rossko-site-api-adapter.ts";
import { clearRosskoStorageState, hasRosskoStorageState, verifyRosskoCredentials } from "./suppliers/rossko/rossko-site-auth.ts";
import { closeSiteHttpAgent } from "./suppliers/site-http.ts";
import { StpartsApiAdapter, verifyStpartsApiCredentials } from "./suppliers/stparts/stparts-api-adapter.ts";
import type {
  ArmtekCredentials,
  MladovCredentials,
  MotorDetalCredentials,
  PartKomCredentials,
  RosskoSiteCredentials,
  SupplierSearchQuery,
  SearchStreamEvent,
  StpartsCredentials,
  SupplierId,
} from "./types.ts";

const sessionManager = new SupplierSessionManager();
const credentialStore = new EncryptedSupplierCredentialStore(
  getStateFilePath("supplier-credentials.enc.json"),
  supplierCredentialsEncryptionKey,
);
const adapters = [
  new RosskoSiteApiAdapter(),
  new ArmtekApiAdapter(),
  new PartKomApiAdapter(),
  new StpartsApiAdapter(),
  new MotorDetalApiAdapter(),
  new MladovWebAdapter(),
];

const sessionService = new SupplierSessionService(adapters, sessionManager, {
  verifyRosskoCredentials,
  verifyArmtekCredentials,
  verifyPartKomApiCredentials: (credentials, signal) => verifyPartKomApiCredentials(credentials, undefined, signal),
  verifyStpartsApiCredentials,
  verifyMotorDetalCredentials,
  verifyMladovCredentials,
  clearRosskoStorageState,
  clearArmtekApiAccountState,
  clearMotorDetalTokenState,
  clearMladovStorageState,
}, credentialStore);
const searchService = new SearchApplicationService(
  adapters,
  sessionManager,
  (supplier) => sessionService.disconnectSupplier(supplier),
);

function bootstrapPersistedSessions(): void {
  const rosskoCredentials = credentialStore.get("rossko");
  const armtekCredentials = credentialStore.get("armtek") ?? getArmtekApiConfig();
  const partKomCredentials = credentialStore.get("part-kom");
  const stpartsCredentials = credentialStore.get("stparts") ?? getStpartsApiConfig();
  const motorDetalCredentials = credentialStore.get("motordetal");
  const mladovCredentials = credentialStore.get("mladov");
  if (armtekCredentials) {
    sessionManager.setArmtekCredentials(armtekCredentials);
  }
  if (partKomCredentials) {
    sessionManager.setPartKomCredentials(partKomCredentials);
  }
  if (stpartsCredentials) {
    sessionManager.setStpartsCredentials(stpartsCredentials);
  }
  if (motorDetalCredentials) {
    sessionManager.setMotorDetalCredentials(motorDetalCredentials);
  }
  if (mladovCredentials) {
    sessionManager.setMladovCredentials(mladovCredentials);
  }
  if (hasRosskoStorageState() || rosskoCredentials) {
    sessionManager.markAuthorized("rossko");
  }
  if (armtekCredentials) {
    sessionManager.markAuthorized("armtek", "Armtek API credentials are configured");
  }
  if (partKomCredentials) {
    sessionManager.markAuthorized("part-kom", "PartKOM API credentials are configured");
  }
  if (stpartsCredentials) {
    sessionManager.markAuthorized("stparts", "STParts API credentials are configured");
  }
  if (hasMotorDetalTokenState() || motorDetalCredentials) {
    sessionManager.markAuthorized("motordetal", "MotorDetal stored session is available");
  }
  if (hasMladovStorageState() || mladovCredentials) {
    sessionManager.markAuthorized("mladov", "Сохраненная сессия Механик Ладов доступна");
  }
}

bootstrapPersistedSessions();

export const listSupplierSessions = () => sessionService.listSupplierSessions();
export const authorizeRossko = (credentials: RosskoSiteCredentials, signal: AbortSignal) => sessionService.authorizeRossko(credentials, signal);
export const authorizeArmtek = (credentials: ArmtekCredentials, signal: AbortSignal) => sessionService.authorizeArmtek(credentials, signal);
export const authorizePartKom = (credentials: PartKomCredentials, signal: AbortSignal) => sessionService.authorizePartKom(credentials, signal);
export const authorizeStparts = (credentials: StpartsCredentials, signal: AbortSignal) => sessionService.authorizeStparts(credentials, signal);
export const authorizeMotorDetal = (credentials: MotorDetalCredentials, signal: AbortSignal) => sessionService.authorizeMotorDetal(credentials, signal);
export const authorizeMladov = (credentials: MladovCredentials, signal: AbortSignal) => sessionService.authorizeMladov(credentials, signal);
export const logoutRossko = () => sessionService.logoutRossko();
export const logoutArmtek = () => sessionService.logoutArmtek();
export const logoutPartKom = () => sessionService.logoutPartKom();
export const logoutStparts = () => sessionService.logoutStparts();
export const logoutMotorDetal = () => sessionService.logoutMotorDetal();
export const logoutMladov = () => sessionService.logoutMladov();

export function validateSupplierSessions(article: string, suppliers: SupplierId[], signal: AbortSignal) {
  return sessionService.validateSupplierSessions(article, suppliers, signal);
}

export function streamSearch(query: SupplierSearchQuery, emit: (event: SearchStreamEvent) => void, signal: AbortSignal) {
  return searchService.streamSearch(query, emit, signal);
}

export async function shutdownSearchService(): Promise<void> {
  closeRosskoHttpAgent();
  closeSiteHttpAgent();
  await closeMladovBrowser();
}
