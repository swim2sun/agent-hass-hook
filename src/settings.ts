import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";

export const EVENT_MAP: Record<string, string> = {
  on_stop: "Stop",
  on_user_prompt_submit: "UserPromptSubmit",
};

interface HookCmd { type: string; command: string; }
interface HookEntry { matcher?: string; hooks?: HookCmd[]; }
interface Settings { hooks?: Record<string, HookEntry[]>; [k: string]: unknown; }

function ourCommand(cmd: string | undefined): boolean {
  const c = cmd ?? "";
  return c.includes("agent-hass-hook") && (c.includes("/bin.js") || c.includes("hook.sh") || c.includes("stop.sh"));
}

export function registerEvents(settings: Settings, events: string[], binPath: string): Settings {
  const hooks = settings.hooks ?? (settings.hooks = {});
  for (const ev of events) {
    const claude = EVENT_MAP[ev];
    if (!claude) continue;
    const cmd = `node ${binPath} hook ${ev}`;
    const arr = hooks[claude] ?? (hooks[claude] = []);
    const existing = arr.flatMap((e) => (e.hooks ?? []).map((h) => h.command));
    if (!existing.includes(cmd)) {
      arr.push({ matcher: "", hooks: [{ type: "command", command: cmd }] });
    }
  }
  return settings;
}

export function removeOurHooks(settings: Settings): Settings {
  const hooks = settings.hooks ?? {};
  for (const [event, arr] of Object.entries(hooks)) {
    if (!Array.isArray(arr)) continue;
    const newArr: HookEntry[] = [];
    for (const entry of arr) {
      const kept = (entry.hooks ?? []).filter((h) => !ourCommand(h.command));
      if (kept.length) newArr.push({ ...entry, hooks: kept });
    }
    if (newArr.length) hooks[event] = newArr;
    else delete hooks[event];
  }
  return settings;
}

export function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function writeSettings(path: string, settings: Settings, backup = true): void {
  mkdirSync(dirname(path), { recursive: true });
  if (backup && existsSync(path)) copyFileSync(path, path + ".bak-agent-hass-hook");
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
}
