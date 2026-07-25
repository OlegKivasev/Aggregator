import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SupplierSessionInvalidatedError } from "../errors.ts";

export function writeJsonStateFileAtomic(
  filePath: string,
  value: unknown,
  canCommit: () => boolean = () => true,
): void {
  if (!canCommit()) {
    throw new SupplierSessionInvalidatedError();
  }

  const stateDir = dirname(filePath);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;

  try {
    writeFileSync(temporaryPath, JSON.stringify(value), { encoding: "utf-8", mode: 0o600, flag: "wx" });
    chmodSync(temporaryPath, 0o600);
    if (!canCommit()) {
      throw new SupplierSessionInvalidatedError();
    }
    renameSync(temporaryPath, filePath);
    chmodSync(filePath, 0o600);
  } finally {
    if (existsSync(temporaryPath)) {
      rmSync(temporaryPath, { force: true });
    }
  }
}
