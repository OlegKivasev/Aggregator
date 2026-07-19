import type {
  ArmtekCredentials,
  MotorDetalCredentials,
  MladovCredentials,
  RosskoSiteCredentials,
  SupplierId,
  SupplierSessionState,
} from "../types.ts";

const nowIso = () => new Date().toISOString();
const supplierIds = ["rossko", "armtek", "part-kom", "stparts", "motordetal", "mladov"] as const;

export class SupplierSessionManager {
  private readonly sessions = new Map<SupplierId, SupplierSessionState>();
  private rosskoCredentials: RosskoSiteCredentials | null = null;
  private armtekCredentials: ArmtekCredentials | null = null;
  private motorDetalCredentials: MotorDetalCredentials | null = null;
  private mladovCredentials: MladovCredentials | null = null;

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

  setRosskoCredentials(credentials: RosskoSiteCredentials): void {
    this.rosskoCredentials = {
      login: credentials.login.trim(),
      password: credentials.password.trim(),
    };
  }

  getRosskoCredentials(): RosskoSiteCredentials | null {
    return this.rosskoCredentials;
  }

  clearRosskoCredentials(): void {
    this.rosskoCredentials = null;
  }

  setArmtekCredentials(credentials: ArmtekCredentials): void {
    this.armtekCredentials = {
      login: credentials.login.trim(),
      password: credentials.password.trim(),
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
      password: credentials.password.trim(),
    };
  }

  getMotorDetalCredentials(): MotorDetalCredentials | null {
    return this.motorDetalCredentials;
  }

  clearMotorDetalCredentials(): void {
    this.motorDetalCredentials = null;
  }

  setMladovCredentials(credentials: MladovCredentials): void {
    this.mladovCredentials = { login: credentials.login.trim(), password: credentials.password.trim() };
  }

  getMladovCredentials(): MladovCredentials | null {
    return this.mladovCredentials;
  }

  clearMladovCredentials(): void {
    this.mladovCredentials = null;
  }
}
