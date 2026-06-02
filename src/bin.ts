#!/usr/bin/env node
async function main(argv: string[]): Promise<number> {
  if (argv[0] === "hook") {
    return 0; // runtime wired up in a later task
  }
  return 0; // configurator wired up in a later task
}
main(process.argv.slice(2)).then((code) => process.exit(code));
