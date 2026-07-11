#!/usr/bin/env node
import { runSbi } from "./run.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] && !args[0].startsWith("--") ? args[0] : "run";
  const flagArgs = command === "run" ? args.slice(args[0] === "run" ? 1 : 0) : args.slice(1);

  if (command === "help" || hasFlag(args, "help")) {
    printHelp();
    return;
  }

  if (command !== "run") {
    throw new Error(`Unsupported command "${command}". Only "run" is available right now.`);
  }

  const flags = parseFlags(flagArgs);
  const exitCode = await runSbi({ flags });
  process.exitCode = exitCode;
}

function parseFlags(args: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};

  for (const arg of args) {
    if (!arg.startsWith("--")) {
      continue;
    }

    const body = arg.slice(2);
    if (!body) {
      continue;
    }

    const separator = body.indexOf("=");
    if (separator === -1) {
      flags[body] = true;
      continue;
    }

    const key = body.slice(0, separator);
    const value = body.slice(separator + 1);
    flags[key] = value;
  }

  return flags;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function printHelp(): void {
  console.log(`SBI canonical CLI

Usage:
  sbi run [options]

Options:
  --site-url=https://example.com
  --dist-dir=dist
  --sitemap-path=dist/sitemap-0.xml
  --state-path=.sbi/state.json
  --manifest-path=.sbi/manifest.json
  --log-path=.sbi/submissions.json
  --dry-run
  --force-submit
  --google=off|optional|required
  --indexnow=off|optional|required
  --help
`);
}

main().catch((error) => {
  console.error("SBI:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
