#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export const VERSION = "0.1.0";

export const HELP_TEXT = `SDI ${VERSION}
Search Discovery Infrastructure

Usage:
  sdi --help

Planned commands for SDI 0.1 (not available yet):
  sdi run       Detect and publish URL changes.
  sdi baseline  Save the current inventory without publishing.

Options:
  -h, --help     Show this help message.
  -V, --version  Show the SDI version.
`;

export function resolveCliResponse(args: readonly string[]): {
  exitCode: number;
  output: string;
  stream: "stdout" | "stderr";
} {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    return { exitCode: 0, output: HELP_TEXT, stream: "stdout" };
  }

  if (args.includes("--version") || args.includes("-V")) {
    return { exitCode: 0, output: `${VERSION}\n`, stream: "stdout" };
  }

  return {
    exitCode: 2,
    output: "SDI is in the foundation stage. No functional commands are available yet. Use sdi --help.\n",
    stream: "stderr",
  };
}

function isDirectInvocation(): boolean {
  const entryPath = process.argv[1];

  return entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url;
}

if (isDirectInvocation()) {
  const response = resolveCliResponse(process.argv.slice(2));
  process[response.stream].write(response.output);
  process.exitCode = response.exitCode;
}
