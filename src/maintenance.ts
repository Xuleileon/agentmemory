import { existsSync } from "node:fs";

export function isMaintenanceLocked(): boolean {
  const lockFile = process.env.AGENTMEMORY_MAINTENANCE_LOCK_FILE?.trim();
  return Boolean(lockFile && existsSync(lockFile));
}
