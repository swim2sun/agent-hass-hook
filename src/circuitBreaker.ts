import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export class CircuitBreaker {
  private consecutiveFailures = 0;
  private trippedAt: number | null = null;

  constructor(
    private readonly statePath: string,
    private readonly failureThreshold = 3,
    private readonly openDurationSec = 300,
    private readonly now: () => number = () => Date.now() / 1000,
  ) {
    mkdirSync(dirname(statePath), { recursive: true });
    this.load();
  }

  private load(): void {
    if (!existsSync(this.statePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.statePath, "utf-8"));
      this.consecutiveFailures = Number(raw.consecutive_failures ?? 0);
      this.trippedAt = raw.tripped_at != null ? Number(raw.tripped_at) : null;
    } catch {
      /* corrupt state — treat as closed */
    }
  }

  private save(): void {
    const payload = { consecutive_failures: this.consecutiveFailures, tripped_at: this.trippedAt };
    try {
      const tmp = this.statePath + ".tmp";
      writeFileSync(tmp, JSON.stringify(payload));
      renameSync(tmp, this.statePath);
    } catch {
      /* best effort */
    }
  }

  shouldSkip(): boolean {
    if (this.trippedAt === null) return false;
    return this.now() - this.trippedAt < this.openDurationSec;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.trippedAt = null;
    this.save();
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.trippedAt = this.now();
    }
    this.save();
  }
}
