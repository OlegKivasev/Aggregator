import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, RequestBodyError } from "../http/request-body.ts";
import { serveJson } from "../http/responses.ts";

export const userPermissions = ["markup", "applicability", "repairs", "testRepairs"] as const;
export type UserPermission = typeof userPermissions[number];

export interface AuthenticatedUser {
  id: string;
  fio: string;
  isAdmin: boolean;
  permissions: UserPermission[];
}
export interface UserInput {
  fio: string;
  password?: string;
  permissions: UserPermission[];
}

interface StoredUser extends AuthenticatedUser {
  passwordHash: string;
  passwordSalt: string;
}

interface Session {
  userId: string;
  expiresAt: number;
}

const sessionCookie = "aggregator_session";
const sessionLifetimeMs = 8 * 60 * 60 * 1000;
const maxFioLength = 256;
const maxPasswordLength = 4096;

function normalizeFio(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function fioKey(value: string): string {
  return normalizeFio(value).toLocaleLowerCase("ru-RU");
}

function parsePermissions(value: unknown): UserPermission[] {
  if (!Array.isArray(value) || value.some((permission) => typeof permission !== "string" || !userPermissions.includes(permission as UserPermission))) {
    throw new RequestBodyError(400, "permissions must contain supported access values");
  }
  return [...new Set(value as UserPermission[])];
}

function validateFio(value: unknown): string {
  if (typeof value !== "string") throw new RequestBodyError(400, "fio is required");
  const fio = normalizeFio(value);
  if (!fio || fio.length > maxFioLength || /[\u0000-\u001f\u007f-\u009f]/.test(fio)) {
    throw new RequestBodyError(400, "fio must be a non-empty string within the allowed length");
  }
  return fio;
}

function validatePassword(value: unknown, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || (required && value.length < 3) || (!required && value.length > 0 && value.length < 3)
    || value.length > maxPasswordLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new RequestBodyError(400, "password must contain 3 to 4096 characters without control characters");
  }
  return value;
}

function hashPassword(password: string, salt = randomBytes(16)): { hash: string; salt: string } {
  const hash = scryptSync(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
  return { hash: hash.toString("base64"), salt: salt.toString("base64") };
}

function verifyPassword(password: string, storedHash: string, storedSalt: string): boolean {
  try {
    const expected = Buffer.from(storedHash, "base64");
    const salt = Buffer.from(storedSalt, "base64");
    if (expected.length !== 64 || salt.length < 16) return false;
    const actual = scryptSync(password, salt, expected.length, { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function cookieValue(request: IncomingMessage): string | null {
  const header = request.headers.cookie;
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === sessionCookie) return value.join("=") || null;
  }
  return null;
}

function setSessionCookie(response: ServerResponse, token: string): void {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${sessionCookie}=${token}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${sessionLifetimeMs / 1000}`);
}

function clearSessionCookie(response: ServerResponse): void {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${sessionCookie}=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`);
}

function storedUser(row: Record<string, unknown>): StoredUser {
  if (typeof row.id !== "string" || typeof row.fio !== "string" || typeof row.password_hash !== "string"
    || typeof row.password_salt !== "string" || (row.is_admin !== 0 && row.is_admin !== 1) || typeof row.permissions !== "string") {
    throw new Error("Invalid stored user");
  }
  let permissions: unknown;
  try { permissions = JSON.parse(row.permissions); } catch { throw new Error("Invalid stored user permissions"); }
  return {
    id: row.id,
    fio: row.fio,
    isAdmin: row.is_admin === 1,
    permissions: parsePermissions(permissions),
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
  };
}

function publicUser(user: StoredUser): AuthenticatedUser {
  return { id: user.id, fio: user.fio, isAdmin: user.isAdmin, permissions: user.permissions };
}

export class UserAuthService {
  readonly enabled: boolean;
  private readonly database: DatabaseSync;
  private readonly sessions = new Map<string, Session>();
  private readonly findByIdStatement: StatementSync;
  private readonly findByFioStatement: StatementSync;
  private readonly listStatement: StatementSync;

  constructor(path: string, adminFio: string, adminPassword: string | null) {
    this.enabled = adminPassword !== null;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS aggregator_users (
        id TEXT PRIMARY KEY NOT NULL,
        fio TEXT NOT NULL,
        fio_key TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        is_admin INTEGER NOT NULL CHECK (is_admin IN (0, 1)),
        permissions TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
    `);
    this.findByIdStatement = this.database.prepare("SELECT id, fio, password_hash, password_salt, is_admin, permissions FROM aggregator_users WHERE id = ?");
    this.findByFioStatement = this.database.prepare("SELECT id, fio, password_hash, password_salt, is_admin, permissions FROM aggregator_users WHERE fio_key = ?");
    this.listStatement = this.database.prepare("SELECT id, fio, password_hash, password_salt, is_admin, permissions FROM aggregator_users ORDER BY is_admin DESC, fio_key ASC");
    if (this.enabled) {
      const existingAdmin = this.database.prepare("SELECT id FROM aggregator_users WHERE is_admin = 1 LIMIT 1").get();
      if (!existingAdmin) {
        const password = adminPassword!;
        const { hash, salt } = hashPassword(password);
        this.database.prepare("INSERT INTO aggregator_users (id, fio, fio_key, password_hash, password_salt, is_admin, permissions, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)")
          .run(randomBytes(16).toString("hex"), validateFio(adminFio), fioKey(adminFio), hash, salt, JSON.stringify(userPermissions), new Date().toISOString());
      }
    }
  }

  close(): void {
    this.database.close();
  }

  currentUser(request: IncomingMessage): AuthenticatedUser | null {
    if (!this.enabled) return null;
    const token = cookieValue(request);
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
      if (session) this.sessions.delete(token);
      return null;
    }
    const row = this.findByIdStatement.get(session.userId) as Record<string, unknown> | undefined;
    return row ? publicUser(storedUser(row)) : null;
  }

  private requireAdmin(request: IncomingMessage, response: ServerResponse): AuthenticatedUser | null {
    const user = this.currentUser(request);
    if (!user || !user.isAdmin) {
      serveJson(response, user ? 403 : 401, { message: user ? "Недостаточно прав." : "Требуется авторизация." });
      return null;
    }
    return user;
  }

  authorize(request: IncomingMessage, response: ServerResponse, permission: UserPermission | "admin" | null): AuthenticatedUser | null {
    if (!this.enabled) return null;
    const user = this.currentUser(request);
    if (!user) {
      serveJson(response, 401, { message: "Требуется авторизация." });
      return null;
    }
    if (permission === "admin" && !user.isAdmin || permission !== null && permission !== "admin" && !user.permissions.includes(permission)) {
      serveJson(response, 403, { message: "Недостаточно прав для этого раздела." });
      return null;
    }
    return user;
  }

  async serve(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname.startsWith("/api/auth") || url.pathname === "/api/users") response.setHeader("Cache-Control", "no-store");
    if (url.pathname === "/api/auth/users" && request.method === "GET") {
      serveJson(response, 200, { users: this.listUsers().filter((user) => !user.isAdmin).map(({ fio }) => ({ fio })) });
      return true;
    }
    if (url.pathname === "/api/auth/session" && request.method === "GET") {
      serveJson(response, 200, { enabled: this.enabled, user: this.currentUser(request) });
      return true;
    }
    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      try {
        const payload = await readJsonBody(request);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new RequestBodyError(400, "fio and password are required");
        const fio = validateFio((payload as Record<string, unknown>).fio);
        const password = validatePassword((payload as Record<string, unknown>).password, true)!;
        const row = this.findByFioStatement.get(fioKey(fio)) as Record<string, unknown> | undefined;
        const user = row ? storedUser(row) : null;
        if (!this.enabled || !user || !verifyPassword(password, user.passwordHash, user.passwordSalt)) {
          serveJson(response, 401, { message: "Неверные ФИО или пароль." });
          return true;
        }
        const token = randomBytes(32).toString("base64url");
        this.sessions.set(token, { userId: user.id, expiresAt: Date.now() + sessionLifetimeMs });
        setSessionCookie(response, token);
        serveJson(response, 200, { user: publicUser(user) });
      } catch (error) {
        serveJson(response, error instanceof RequestBodyError ? error.statusCode : 400, { message: error instanceof RequestBodyError ? error.message : "Неверный запрос авторизации." });
      }
      return true;
    }
    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      const token = cookieValue(request);
      if (token) this.sessions.delete(token);
      clearSessionCookie(response);
      serveJson(response, 200, { ok: true });
      return true;
    }
    if (url.pathname === "/api/users") {
      const user = this.requireAdmin(request, response);
      if (!user) return true;
      try {
        if (request.method === "GET") {
          serveJson(response, 200, { users: this.listUsers() });
        } else if (request.method === "POST") {
          const payload = await readJsonBody(request);
          const input = this.parseUserInput(payload, true);
          serveJson(response, 201, { user: this.createUser(input) });
        } else if (request.method === "PATCH") {
          const payload = await readJsonBody(request);
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new RequestBodyError(400, "id is required");
          const value = payload as Record<string, unknown>;
          if (typeof value.id !== "string") throw new RequestBodyError(400, "id is required");
          const input = this.parseUserInput(payload, false);
          serveJson(response, 200, { user: this.updateUser(value.id, input) });
        } else if (request.method === "DELETE") {
          const payload = await readJsonBody(request);
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new RequestBodyError(400, "id is required");
          const value = payload as Record<string, unknown>;
          if (typeof value.id !== "string") throw new RequestBodyError(400, "id is required");
          this.deleteUser(value.id, user.id);
          serveJson(response, 204, null);
        } else {
          response.setHeader("Allow", "GET, POST, PATCH, DELETE");
          serveJson(response, 405, { message: "Method not allowed" });
        }
      } catch (error) {
        const status = error instanceof RequestBodyError ? error.statusCode : error instanceof Error && error.message.includes("already") ? 409 : 400;
        const message = error instanceof RequestBodyError
          ? error.message
          : error instanceof Error && ["User not found", "User with this FIO already exists", "Администратора удалить нельзя."].includes(error.message)
            ? error.message
            : "Не удалось сохранить пользователя.";
        serveJson(response, status, { message });
      }
      return true;
    }
    return false;
  }

  private parseUserInput(payload: unknown, passwordRequired: boolean): UserInput {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new RequestBodyError(400, "User object is required");
    const value = payload as Record<string, unknown>;
    return { fio: validateFio(value.fio), password: validatePassword(value.password, passwordRequired), permissions: parsePermissions(value.permissions) };
  }

  private listUsers(): AuthenticatedUser[] {
    return this.listStatement.all().map((row) => publicUser(storedUser(row as Record<string, unknown>)));
  }

  private createUser(input: UserInput): AuthenticatedUser {
    if (!input.password) throw new RequestBodyError(400, "password is required");
    if (this.findByFioStatement.get(fioKey(input.fio))) throw new Error("User with this FIO already exists");
    const { hash, salt } = hashPassword(input.password);
    const id = randomBytes(16).toString("hex");
    this.database.prepare("INSERT INTO aggregator_users (id, fio, fio_key, password_hash, password_salt, is_admin, permissions, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)")
      .run(id, input.fio, fioKey(input.fio), hash, salt, JSON.stringify(input.permissions), new Date().toISOString());
    return { id, fio: input.fio, isAdmin: false, permissions: input.permissions };
  }

  private updateUser(id: string, input: UserInput): AuthenticatedUser {
    const row = this.findByIdStatement.get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error("User not found");
    const existing = storedUser(row);
    const duplicate = this.findByFioStatement.get(fioKey(input.fio)) as Record<string, unknown> | undefined;
    if (duplicate && duplicate.id !== id) throw new Error("User with this FIO already exists");
    const credentials = input.password ? hashPassword(input.password) : { hash: existing.passwordHash, salt: existing.passwordSalt };
    this.database.prepare("UPDATE aggregator_users SET fio = ?, fio_key = ?, password_hash = ?, password_salt = ?, permissions = ? WHERE id = ?")
      .run(input.fio, fioKey(input.fio), credentials.hash, credentials.salt, JSON.stringify(input.permissions), id);
    return { id, fio: input.fio, isAdmin: existing.isAdmin, permissions: input.permissions };
  }

  private deleteUser(id: string, currentUserId: string): void {
    const row = this.findByIdStatement.get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error("User not found");
    const user = storedUser(row);
    if (id === currentUserId || user.isAdmin) throw new Error("Администратора удалить нельзя.");
    this.database.prepare("DELETE FROM aggregator_users WHERE id = ?").run(id);
    for (const [token, session] of this.sessions) if (session.userId === id) this.sessions.delete(token);
  }
}
