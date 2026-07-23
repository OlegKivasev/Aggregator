import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getStateFilePath } from "../../config.ts";

interface ArmtekApiAccountState {
  loginHash: string;
  vkorg: string;
  kunnrRg: string;
}

const statePath = getStateFilePath("armtek-api-account-state.json");
const stateDir = dirname(statePath);

function hashLogin(login: string): string {
  return createHash("sha256").update(login).digest("hex");
}

function isAccountValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001F\u007F]/.test(value);
}

export function parseArmtekApiAccountState(value: unknown, login: string): Pick<ArmtekApiAccountState, "vkorg" | "kunnrRg"> | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const state = value as Partial<ArmtekApiAccountState>;
  if (state.loginHash !== hashLogin(login) || !isAccountValue(state.vkorg) || !isAccountValue(state.kunnrRg)) {
    return null;
  }

  return { vkorg: state.vkorg, kunnrRg: state.kunnrRg };
}

export function getArmtekApiAccountState(login: string): Pick<ArmtekApiAccountState, "vkorg" | "kunnrRg"> | null {
  if (!existsSync(statePath)) {
    return null;
  }

  try {
    return parseArmtekApiAccountState(JSON.parse(readFileSync(statePath, "utf-8")), login);
  } catch {
    return null;
  }
}

export function saveArmtekApiAccountState(login: string, vkorg: string, kunnrRg: string): void {
  if (!isAccountValue(vkorg) || !isAccountValue(kunnrRg)) {
    throw new Error("Armtek returned invalid account configuration");
  }

  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const temporaryPath = `${statePath}.${randomUUID()}.tmp`;
  const state: ArmtekApiAccountState = { loginHash: hashLogin(login), vkorg, kunnrRg };

  try {
    writeFileSync(temporaryPath, JSON.stringify(state), { encoding: "utf-8", mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, statePath);
    chmodSync(statePath, 0o600);
  } finally {
    // A failed atomic replacement can leave only this non-sensitive temporary state file.
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}

export function clearArmtekApiAccountState(): void {
  if (existsSync(statePath)) {
    rmSync(statePath, { force: true });
  }
}
