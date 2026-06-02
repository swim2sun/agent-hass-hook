import { join } from "node:path";

export interface Paths {
  configPath: string;
  stateDir: string;
  logPath: string;
  breakerPath: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv): Paths {
  const home = env.HOME ?? "";
  const configHome = env.XDG_CONFIG_HOME ?? join(home, ".config");
  const stateHome = env.XDG_STATE_HOME ?? join(home, ".local", "state");

  const configPath = env.AGENT_HASS_HOOK_CONFIG ?? join(configHome, "agent-hass-hook", "config.json");
  const stateDir = env.AGENT_HASS_HOOK_STATE_DIR ?? join(stateHome, "agent-hass-hook");

  return {
    configPath,
    stateDir,
    logPath: join(stateDir, "hook.log"),
    breakerPath: join(stateDir, "breaker.json"),
  };
}
