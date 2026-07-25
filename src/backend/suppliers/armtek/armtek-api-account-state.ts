import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { getStateFilePath } from "../../config.ts";
import { writeJsonStateFileAtomic } from "../../session/state-file.ts";

interface ArmtekApiAccountState {
  loginHash: string;
  vkorg: string;
  kunnrRg: string;
}

const statePath = getStateFilePath("armtek-api-account-state.json");
let stateGeneration = 0;

export function getArmtekApiAccountStateGeneration(): number {
  return stateGeneration;
}

export function invalidateArmtekApiAccountStateWrites(): void {
  stateGeneration += 1;
}

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

export function saveArmtekApiAccountState(
  login: string,
  vkorg: string,
  kunnrRg: string,
  expectedGeneration = stateGeneration,
): void {
  if (!isAccountValue(vkorg) || !isAccountValue(kunnrRg)) {
    throw new Error("Armtek returned invalid account configuration");
  }

  const state: ArmtekApiAccountState = { loginHash: hashLogin(login), vkorg, kunnrRg };
  writeJsonStateFileAtomic(statePath, state, () => stateGeneration === expectedGeneration);
}

export function clearArmtekApiAccountState(): void {
  stateGeneration += 1;
  if (existsSync(statePath)) {
    rmSync(statePath, { force: true });
  }
}
