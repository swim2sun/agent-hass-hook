import { openSync, fchmodSync, writeSync, closeSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Writes config.json with 0600 perms, forcing perms even if the file pre-existed.
export function writeConfig(path: string, obj: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "w", 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, JSON.stringify(obj, null, 2) + "\n");
  } finally {
    closeSync(fd);
  }
}
