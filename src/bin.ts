#!/usr/bin/env node
import { resolvePaths } from "./paths.ts";

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

async function main(argv: string[]): Promise<number> {
  const paths = resolvePaths(process.env);

  if (argv[0] === "hook") {
    const { runHook } = await import("./dispatch.ts");
    const event = argv[1] ?? "on_stop";
    const stdinText = await readStdin();
    return runHook(event, stdinText, process.env, paths);
  }

  if (argv[0] === "uninstall") {
    const { readSettings, removeOurHooks, writeSettings } = await import("./settings.ts");
    const settingsPath = `${process.env.HOME}/.claude/settings.json`;
    try {
      writeSettings(settingsPath, removeOurHooks(readSettings(settingsPath)));
      process.stdout.write("agent-hass-hook: removed hooks from settings.json\n");
    } catch (e) {
      process.stderr.write(`agent-hass-hook: ${(e as Error).message}\n`);
    }
    return 0;
  }

  const { runConfigurator } = await import("./configurator.ts");
  return runConfigurator(paths);
}

main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => {
  process.stderr.write(`agent-hass-hook: ${e?.stack ?? e}\n`);
  process.exit(0); // never block Claude Code on a hook crash
});
