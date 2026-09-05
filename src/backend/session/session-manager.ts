import type {
  ArmtekCredentials,
  ForumAutoCredentials,
  MotorDetalCredentials,
  MladovCredentials,
  PartKomCredentials,
  RosskoApiCredentials,
  StpartsCredentials,
  SupplierId,
  SupplierSessionState,
} from "../types.ts";
import { SupplierSessionInvalidatedError } from "../errors.ts";

export interface SupplierOperation {
  readonly generation: number;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  supersedeOthers(): void;
  dispose(): void;
}

const nowIso = () => new Date().toISOString();
const supplierIds = ["rossko", "armtek", "part-kom", "stparts", "forum-auto", "motordetal", "mladov"] as const;

export class SupplierSessionManager {
  private readonly sessions = new Map<SupplierId, SupplierSessionState>();
  private readonly generations = new Map<SupplierId, number>();
  private readonly activeOperations = new Map<SupplierId, Set<AbortController>>();
  private readonly exclusiveOperations = new Map<SupplierId, AbortSignal>();
  private armtekCredentials: ArmtekCredentials | null = null;
  private motorDetalCredentials: MotorDetalCredentials | null = null;
  private mladovCredentials: MladovCredentials | null = null;
  private partKomCredentials: PartKomCredentials | null = null;
  private stpartsCredentials: StpartsCredentials | null = null;
  private forumAutoCredentials: ForumAutoCredentials | null = null;
  private rosskoApiCredentials: RosskoApiCredentials | null = null;

  getSession(supplier: SupplierId): SupplierSessionState {
    const current = this.sessions.get(supplier);

    if (current) {
      return current;
    }

    const created: SupplierSessionState = {
      supplier,
      authorized: false,
      lastCheckedAt: null,
      lastAuthorizedAt: null,
    };

    this.sessions.set(supplier, created);
    return created;
  }

  getAllSessions(): SupplierSessionState[] {
    return supplierIds.map((supplier) => this.getSession(supplier));
  }

  beginOperation(supplier: SupplierId, parentSignal: AbortSignal): SupplierOperation {
    const operation = this.createOperation(supplier, parentSignal);
    if (this.exclusiveOperations.has(supplier)) {
      const controller = this.operationController(operation);
      controller.abort(new SupplierSessionInvalidatedError("Supplier authorization is in progress"));
    }
    return operation;
  }

  beginExclusiveOperation(supplier: SupplierId, parentSignal: AbortSignal): SupplierOperation {
    this.invalidateOperations(supplier);
    const operation = this.createOperation(supplier, parentSignal);
    const originalDispose = operation.dispose;
    this.exclusiveOperations.set(supplier, operation.signal);
    operation.dispose = () => {
      originalDispose();
      if (this.exclusiveOperations.get(supplier) === operation.signal) {
        this.exclusiveOperations.delete(supplier);
      }
    };
    return operation;
  }

  private createOperation(supplier: SupplierId, parentSignal: AbortSignal): SupplierOperation {
    let generation = this.generations.get(supplier) ?? 0;
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(parentSignal.reason);
    if (parentSignal.aborted) {
      controller.abort(parentSignal.reason);
    } else {
      parentSignal.addEventListener("abort", forwardAbort, { once: true });
    }
    const operations = this.activeOperations.get(supplier) ?? new Set<AbortController>();
    operations.add(controller);
    this.activeOperations.set(supplier, operations);

    const operation: SupplierOperation & { controller?: AbortController } = {
      get generation() {
        return generation;
      },
      signal: controller.signal,
      isCurrent: () => (this.generations.get(supplier) ?? 0) === generation && !controller.signal.aborted,
      supersedeOthers: () => {
        controller.signal.throwIfAborted();
        generation = (this.generations.get(supplier) ?? 0) + 1;
        this.generations.set(supplier, generation);
        for (const activeController of operations) {
          if (activeController !== controller) {
            activeController.abort(new SupplierSessionInvalidatedError("A newer supplier session was established"));
          }
        }
        operations.clear();
        operations.add(controller);
        this.activeOperations.set(supplier, operations);
      },
      dispose: () => {
        parentSignal.removeEventListener("abort", forwardAbort);
        operations.delete(controller);
        if (!operations.size && this.activeOperations.get(supplier) === operations) {
          this.activeOperations.delete(supplier);
        }
      },
    };
    Object.defineProperty(operation, "controller", { value: controller });
    return operation;
  }

  private operationController(operation: SupplierOperation): AbortController {
    return (operation as SupplierOperation & { controller: AbortController }).controller;
  }

  invalidateOperations(supplier: SupplierId): void {
    this.generations.set(supplier, (this.generations.get(supplier) ?? 0) + 1);
    for (const controller of this.activeOperations.get(supplier) ?? []) {
      controller.abort(new SupplierSessionInvalidatedError());
    }
    this.activeOperations.delete(supplier);
    this.exclusiveOperations.delete(supplier);
  }

  markChecked(supplier: SupplierId, details?: string): SupplierSessionState {
    const next: SupplierSessionState = {
      ...this.getSession(supplier),
      lastCheckedAt: nowIso(),
      details,
    };

    this.sessions.set(supplier, next);
    return next;
  }

  markAuthorized(supplier: SupplierId, details?: string): SupplierSessionState {
    const next: SupplierSessionState = {
      ...this.getSession(supplier),
      authorized: true,
      lastCheckedAt: nowIso(),
      lastAuthorizedAt: nowIso(),
      details,
    };

    this.sessions.set(supplier, next);
    return next;
  }

  markUnauthorized(supplier: SupplierId, details?: string): SupplierSessionState {
    const next: SupplierSessionState = {
      ...this.getSession(supplier),
      authorized: false,
      lastCheckedAt: nowIso(),
      details,
    };

    this.sessions.set(supplier, next);
    return next;
  }

  setRosskoApiCredentials(credentials: RosskoApiCredentials): void {
    this.rosskoApiCredentials = {
      key1: credentials.key1.trim(),
      key2: credentials.key2.trim(),
    };
  }

  getRosskoApiCredentials(): RosskoApiCredentials | null {
    return this.rosskoApiCredentials ? { ...this.rosskoApiCredentials } : null;
  }

  clearRosskoApiCredentials(): void {
    this.rosskoApiCredentials = null;
  }

  setArmtekCredentials(credentials: ArmtekCredentials): void {
    this.armtekCredentials = {
      login: credentials.login.trim(),
      password: credentials.password,
    };
  }

  getArmtekCredentials(): ArmtekCredentials | null {
    return this.armtekCredentials;
  }

  clearArmtekCredentials(): void {
    this.armtekCredentials = null;
  }

  setMotorDetalCredentials(credentials: MotorDetalCredentials): void {
    this.motorDetalCredentials = {
      login: credentials.login.trim().toLowerCase(),
      password: credentials.password,
    };
  }

  getMotorDetalCredentials(): MotorDetalCredentials | null {
    return this.motorDetalCredentials;
  }

  clearMotorDetalCredentials(): void {
    this.motorDetalCredentials = null;
  }

  setMladovCredentials(credentials: MladovCredentials): void {
    this.mladovCredentials = { login: credentials.login.trim(), password: credentials.password };
  }

  getMladovCredentials(): MladovCredentials | null {
    return this.mladovCredentials;
  }

  clearMladovCredentials(): void {
    this.mladovCredentials = null;
  }

  setPartKomCredentials(credentials: PartKomCredentials): void {
    this.partKomCredentials = { login: credentials.login.trim(), password: credentials.password };
  }

  getPartKomCredentials(): PartKomCredentials | null {
    return this.partKomCredentials;
  }

  clearPartKomCredentials(): void {
    this.partKomCredentials = null;
  }

  setStpartsCredentials(credentials: StpartsCredentials): void {
    this.stpartsCredentials = { login: credentials.login.trim(), password: credentials.password };
  }

  getStpartsCredentials(): StpartsCredentials | null {
    return this.stpartsCredentials;
  }

  clearStpartsCredentials(): void {
    this.stpartsCredentials = null;
  }

  setForumAutoCredentials(credentials: ForumAutoCredentials): void {
    this.forumAutoCredentials = { login: credentials.login.trim(), password: credentials.password };
  }

  getForumAutoCredentials(): ForumAutoCredentials | null {
    return this.forumAutoCredentials;
  }

  clearForumAutoCredentials(): void {
    this.forumAutoCredentials = null;
  }
}
