import { existsSync, mkdirSync, statSync, renameSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

export class HookLogger {
  constructor(
    private readonly logPath: string,
    private readonly maxBytes = 1_000_000,
    private readonly now: () => string = utcNowIso,
  ) {
    mkdirSync(dirname(logPath), { recursive: true });
    this.maybeRotate();
  }

  private maybeRotate(): void {
    if (!existsSync(this.logPath)) return;
    try {
      if (statSync(this.logPath).size <= this.maxBytes) return;
      renameSync(this.logPath, this.logPath + ".1");
    } catch {
      /* best effort */
    }
  }

  log(fields: Record<string, unknown>): void {
    const record = { ts: this.now(), ...fields };
    try {
      appendFileSync(this.logPath, JSON.stringify(record) + "\n", "utf-8");
    } catch {
      /* never throw from logging */
    }
  }
}

function utcNowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
