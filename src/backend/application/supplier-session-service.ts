import { createBoundedAbortSignal } from "../abort.ts";
import { supplierAuthorizationTimeoutMs } from "../config.ts";
import type { SupplierCredentialRepository, StoredSupplierCredentials } from "../session/encrypted-credential-store.ts";
import type { SupplierSessionManager } from "../session/session-manager.ts";
import type { SupplierAdapter } from "../suppliers/supplier-adapter.ts";
import {
  SupplierAuthError,
  SupplierIntegrationError,
  SupplierSessionInvalidatedError,
  SupplierTimeoutError,
} from "../suppliers/errors.ts";
import type {
  ArmtekCredentials,
  MladovCredentials,
  MotorDetalCredentials,
  PartKomCredentials,
  RosskoSiteCredentials,
  StpartsCredentials,
  SupplierId,
  SupplierSessionValidationResult,
} from "../types.ts";
import { selectSupplierAdapters } from "./search-application-service.ts";

interface CredentialCheckResult {
  authorized: boolean;
  failure?: "authorization" | "integration";
}

export interface SupplierSessionOperations {
  verifyRosskoCredentials(credentials: RosskoSiteCredentials, signal: AbortSignal): Promise<CredentialCheckResult>;
  verifyArmtekCredentials(credentials: ArmtekCredentials, signal: AbortSignal): Promise<string>;
  verifyPartKomApiCredentials(credentials: PartKomCredentials, signal: AbortSignal): Promise<void>;
  verifyStpartsApiCredentials(credentials: StpartsCredentials, signal: AbortSignal): Promise<void>;
  verifyMotorDetalCredentials(credentials: MotorDetalCredentials, signal: AbortSignal): Promise<CredentialCheckResult>;
  verifyMladovCredentials(credentials: MladovCredentials, signal: AbortSignal): Promise<CredentialCheckResult>;
  clearRosskoStorageState(): void;
  clearArmtekApiAccountState(): void;
  clearMotorDetalTokenState(): void;
  clearMladovStorageState(): void;
}

export class SupplierSessionService {
  private readonly adapters: SupplierAdapter[];
  private readonly sessionManager: SupplierSessionManager;
  private readonly operations: SupplierSessionOperations;
  private readonly credentialRepository: SupplierCredentialRepository | null;

  constructor(
    adapters: SupplierAdapter[],
    sessionManager: SupplierSessionManager,
    operations: SupplierSessionOperations,
    credentialRepository: SupplierCredentialRepository | null = null,
  ) {
    this.adapters = adapters;
    this.sessionManager = sessionManager;
    this.operations = operations;
    this.credentialRepository = credentialRepository;
  }

  private rememberCredentials(supplier: SupplierId, credentials: StoredSupplierCredentials): void {
    this.credentialRepository?.set(supplier, { login: credentials.login.trim(), password: credentials.password });
  }

  private forgetCredentials(supplier: SupplierId): void {
    this.credentialRepository?.delete(supplier);
  }

  listSupplierSessions() {
    return this.sessionManager.getAllSessions();
  }

  private rejectAuthorization(supplier: SupplierId, details: string): never {
    if (this.sessionManager.getSession(supplier).authorized) {
      this.sessionManager.markChecked(supplier, details);
    } else {
      this.sessionManager.markUnauthorized(supplier, details);
    }
    throw new SupplierAuthError(details);
  }

  private async runAuthorization<T>(
    signal: AbortSignal,
    supplier: SupplierId,
    supplierName: string,
    authorize: (signal: AbortSignal, establishSession: () => void) => Promise<T>,
  ): Promise<T> {
    const operation = this.sessionManager.beginExclusiveOperation(supplier, signal);
    const boundedSignal = createBoundedAbortSignal(
      operation.signal,
      supplierAuthorizationTimeoutMs,
      `${supplierName} authorization timed out`,
    );
    try {
      let sessionEstablished = false;
      const establishSession = () => {
        if (!sessionEstablished) {
          operation.supersedeOthers();
          sessionEstablished = true;
        }
      };
      const result = await authorize(boundedSignal.signal, establishSession);
      if (!operation.isCurrent()) {
        throw new SupplierSessionInvalidatedError();
      }
      return result;
    } finally {
      boundedSignal.dispose();
      operation.dispose();
    }
  }

  async authorizeRossko(credentials: RosskoSiteCredentials, signal: AbortSignal) {
    return this.runAuthorization(signal, "rossko", "Rossko", async (authorizationSignal, establishSession) => {
      const result = await this.operations.verifyRosskoCredentials(credentials, authorizationSignal);
      authorizationSignal.throwIfAborted();
      if (!result.authorized) {
        if (result.failure === "integration") {
          throw new SupplierIntegrationError("Rossko authorization could not be verified");
        }
        return this.rejectAuthorization("rossko", "Rossko rejected the login or password");
      }
      establishSession();
      this.rememberCredentials("rossko", credentials);
      return this.sessionManager.markAuthorized("rossko", "Rossko business account login was verified successfully");
    });
  }

  logoutRossko() {
    this.sessionManager.invalidateOperations("rossko");
    this.operations.clearRosskoStorageState();
    this.forgetCredentials("rossko");
    return this.sessionManager.markUnauthorized("rossko");
  }

  async authorizeArmtek(credentials: ArmtekCredentials, signal: AbortSignal) {
    return this.runAuthorization(signal, "armtek", "Armtek", async (authorizationSignal, establishSession) => {
      const details = await this.operations.verifyArmtekCredentials(credentials, authorizationSignal);
      authorizationSignal.throwIfAborted();
      establishSession();
      this.rememberCredentials("armtek", credentials);
      this.sessionManager.setArmtekCredentials(credentials);
      return this.sessionManager.markAuthorized("armtek", details);
    });
  }

  logoutArmtek() {
    this.sessionManager.invalidateOperations("armtek");
    this.sessionManager.clearArmtekCredentials();
    this.operations.clearArmtekApiAccountState();
    this.forgetCredentials("armtek");
    return this.sessionManager.markUnauthorized("armtek");
  }

  async authorizePartKom(credentials: PartKomCredentials, signal: AbortSignal) {
    return this.runAuthorization(signal, "part-kom", "PartKOM", async (authorizationSignal, establishSession) => {
      try {
        await this.operations.verifyPartKomApiCredentials(credentials, authorizationSignal);
      } catch (error) {
        authorizationSignal.throwIfAborted();
        if (error instanceof SupplierAuthError) {
          return this.rejectAuthorization("part-kom", "PartKOM API rejected the login or password");
        }
        throw error;
      }
      authorizationSignal.throwIfAborted();
      establishSession();
      this.rememberCredentials("part-kom", credentials);
      this.sessionManager.setPartKomCredentials(credentials);
      return this.sessionManager.markAuthorized("part-kom", "PartKOM API credentials were verified successfully");
    });
  }

  logoutPartKom() {
    this.sessionManager.invalidateOperations("part-kom");
    this.sessionManager.clearPartKomCredentials();
    this.forgetCredentials("part-kom");
    return this.sessionManager.markUnauthorized("part-kom");
  }

  async authorizeStparts(credentials: StpartsCredentials, signal: AbortSignal) {
    return this.runAuthorization(signal, "stparts", "STParts", async (authorizationSignal, establishSession) => {
      try {
        await this.operations.verifyStpartsApiCredentials(credentials, authorizationSignal);
      } catch (error) {
        authorizationSignal.throwIfAborted();
        if (error instanceof SupplierAuthError) {
          return this.rejectAuthorization("stparts", "STParts API rejected the login or password");
        }
        throw error;
      }
      authorizationSignal.throwIfAborted();
      establishSession();
      this.rememberCredentials("stparts", credentials);
      this.sessionManager.setStpartsCredentials(credentials);
      return this.sessionManager.markAuthorized("stparts", "STParts API credentials were verified successfully");
    });
  }

  logoutStparts() {
    this.sessionManager.invalidateOperations("stparts");
    this.sessionManager.clearStpartsCredentials();
    this.forgetCredentials("stparts");
    return this.sessionManager.markUnauthorized("stparts");
  }

  async authorizeMotorDetal(credentials: MotorDetalCredentials, signal: AbortSignal) {
    return this.runAuthorization(signal, "motordetal", "MotorDetal", async (authorizationSignal, establishSession) => {
      const result = await this.operations.verifyMotorDetalCredentials(credentials, authorizationSignal);
      authorizationSignal.throwIfAborted();
      if (!result.authorized) {
        return this.rejectAuthorization("motordetal", "MotorDetal rejected the login or password");
      }
      establishSession();
      this.rememberCredentials("motordetal", credentials);
      this.sessionManager.setMotorDetalCredentials(credentials);
      return this.sessionManager.markAuthorized("motordetal", "MotorDetal account login was verified successfully");
    });
  }

  logoutMotorDetal() {
    this.sessionManager.invalidateOperations("motordetal");
    this.sessionManager.clearMotorDetalCredentials();
    this.operations.clearMotorDetalTokenState();
    this.forgetCredentials("motordetal");
    return this.sessionManager.markUnauthorized("motordetal");
  }

  async authorizeMladov(credentials: MladovCredentials, signal: AbortSignal) {
    return this.runAuthorization(signal, "mladov", "Mladov", async (authorizationSignal, establishSession) => {
      const result = await this.operations.verifyMladovCredentials(credentials, authorizationSignal);
      authorizationSignal.throwIfAborted();
      if (!result.authorized) {
        return this.rejectAuthorization("mladov", "Механик Ладов отклонил логин или пароль");
      }
      establishSession();
      this.rememberCredentials("mladov", credentials);
      this.sessionManager.setMladovCredentials(credentials);
      return this.sessionManager.markAuthorized("mladov", "Авторизация Механик Ладов успешно проверена");
    });
  }

  logoutMladov() {
    this.sessionManager.invalidateOperations("mladov");
    this.sessionManager.clearMladovCredentials();
    this.operations.clearMladovStorageState();
    this.forgetCredentials("mladov");
    return this.sessionManager.markUnauthorized("mladov");
  }

  disconnectSupplier(supplier: SupplierId): void {
    const logoutBySupplier: Record<SupplierId, () => unknown> = {
      rossko: () => this.logoutRossko(),
      armtek: () => this.logoutArmtek(),
      "part-kom": () => this.logoutPartKom(),
      stparts: () => this.logoutStparts(),
      motordetal: () => this.logoutMotorDetal(),
      mladov: () => this.logoutMladov(),
    };
    logoutBySupplier[supplier]();
  }

  private async validateSupplierSessionOnce(
    adapter: SupplierAdapter,
    signal: AbortSignal,
  ): Promise<{ result: SupplierSessionValidationResult; canReauthorize: boolean }> {
    const operation = this.sessionManager.beginOperation(adapter.id, signal);
    if (operation.signal.aborted) {
      operation.dispose();
      return { result: { supplier: adapter.id, status: "expired" }, canReauthorize: false };
    }
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(operation.signal.reason);
    operation.signal.addEventListener("abort", forwardAbort, { once: true });
    const timeoutId = setTimeout(
      () => controller.abort(new SupplierTimeoutError(`Validation timed out after ${adapter.timeoutMs}ms`)),
      adapter.timeoutMs,
    );

    try {
      const session = await adapter.ensureSession(this.sessionManager);
      if (!session.authorized) {
        throw new SupplierAuthError();
      }
      await adapter.validateSession({ signal: controller.signal, timeoutMs: adapter.timeoutMs }, this.sessionManager);
      if (!operation.isCurrent() || controller.signal.aborted) {
        throw controller.signal.reason ?? new SupplierSessionInvalidatedError();
      }
      this.sessionManager.markChecked(adapter.id);
      return { result: { supplier: adapter.id, status: "connected" }, canReauthorize: false };
    } catch (error) {
      if (error instanceof SupplierAuthError) {
        return { result: { supplier: adapter.id, status: "expired" }, canReauthorize: true };
      }
      if (signal.aborted) {
        throw signal.reason;
      }
      if (error instanceof SupplierSessionInvalidatedError || operation.signal.reason instanceof SupplierSessionInvalidatedError) {
        return { result: { supplier: adapter.id, status: "expired" }, canReauthorize: false };
      }
      return { result: { supplier: adapter.id, status: "error" }, canReauthorize: false };
    } finally {
      clearTimeout(timeoutId);
      operation.signal.removeEventListener("abort", forwardAbort);
      operation.dispose();
    }
  }

  private credentialsForAutomaticLogin(supplier: SupplierId): StoredSupplierCredentials | null {
    const stored = this.credentialRepository?.get(supplier);
    if (stored) {
      return stored;
    }
    switch (supplier) {
      case "armtek": return this.sessionManager.getArmtekCredentials();
      case "part-kom": return this.sessionManager.getPartKomCredentials();
      case "stparts": return this.sessionManager.getStpartsCredentials();
      case "motordetal": return this.sessionManager.getMotorDetalCredentials();
      case "mladov": return this.sessionManager.getMladovCredentials();
      case "rossko": return null;
    }
  }

  private authorizeAutomatically(supplier: SupplierId, credentials: StoredSupplierCredentials, signal: AbortSignal) {
    switch (supplier) {
      case "rossko": return this.authorizeRossko(credentials, signal);
      case "armtek": return this.authorizeArmtek(credentials, signal);
      case "part-kom": return this.authorizePartKom(credentials, signal);
      case "stparts": return this.authorizeStparts(credentials, signal);
      case "motordetal": return this.authorizeMotorDetal(credentials, signal);
      case "mladov": return this.authorizeMladov(credentials, signal);
    }
  }

  private async validateSupplierSession(adapter: SupplierAdapter, signal: AbortSignal): Promise<SupplierSessionValidationResult> {
    const validation = await this.validateSupplierSessionOnce(adapter, signal);
    if (!validation.canReauthorize) {
      return validation.result;
    }

    const credentials = this.credentialsForAutomaticLogin(adapter.id);
    if (!credentials) {
      this.disconnectSupplier(adapter.id);
      return validation.result;
    }

    try {
      await this.authorizeAutomatically(adapter.id, credentials, signal);
      return { supplier: adapter.id, status: "connected" };
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason;
      }
      if (error instanceof SupplierAuthError) {
        this.disconnectSupplier(adapter.id);
        return { supplier: adapter.id, status: "expired" };
      }
      if (error instanceof SupplierSessionInvalidatedError) {
        return { supplier: adapter.id, status: "expired" };
      }
      return { supplier: adapter.id, status: "error" };
    }
  }

  async validateSupplierSessions(
    article: string,
    suppliers: SupplierId[],
    signal: AbortSignal,
  ): Promise<{ results: SupplierSessionValidationResult[]; sessions: ReturnType<SupplierSessionService["listSupplierSessions"]> }> {
    const adapters = selectSupplierAdapters(this.adapters, suppliers);
    void article;
    const results = await Promise.all(adapters.map((adapter) => this.validateSupplierSession(adapter, signal)));
    return { results, sessions: this.listSupplierSessions() };
  }
}
