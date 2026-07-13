#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, SdiConfigError } from "./config.js";
import type { ResolvedConfig } from "./config.js";
import type { Diagnostic, ExecutionReport } from "./report/types.js";
import { runBaseline, runDryRun, runLive, type RunOutcome } from "./run.js";
import { SDI_VERSION } from "./version.js";

export const VERSION = SDI_VERSION;

export const HELP_TEXT = `SDI ${VERSION}
Search Discovery Infrastructure

Usage:
  sdi run [--config <path>] [--dry-run] [--force] [--allow-large-delete] [--clear-stale-lock]
  sdi baseline [--config <path>] --confirm [--clear-stale-lock]

Options:
  -h, --help              Show this help message.
  -V, --version           Show the SDI version.
  --config <path>         Load one sdi.config.mjs file.
  --dry-run               Discover and report without network or state writes.
  --force                 Publish unchanged current URLs in live mode.
  --allow-large-delete    Allow live deletion above 50 percent.
  --clear-stale-lock      Explicitly remove a verified stale lock.
  --confirm               Confirm initial baseline creation.
`;

export interface CliExecution {
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

export interface CliDependencies {
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  loadEnvFile?: (path: string) => void;
  loadConfig?: (options: { cwd: string; configPath?: string; environment: NodeJS.ProcessEnv }) => Promise<ResolvedConfig>;
  runDryRun?: typeof runDryRun;
  runBaseline?: typeof runBaseline;
  runLive?: typeof runLive;
}

type ParsedCommand =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string }
  | {
      kind: "run";
      configPath?: string;
      dryRun: boolean;
      force: boolean;
      allowLargeDelete: boolean;
      clearStaleLock: boolean;
    }
  | { kind: "baseline"; configPath?: string; confirmed: boolean; clearStaleLock: boolean };

/** Parses, loads local configuration, invokes the appropriate runner mode, and formats terminal output. */
export async function executeCli(args: readonly string[], dependencies: CliDependencies = {}): Promise<CliExecution> {
  const parsed = parseCommand(args);

  if (parsed.kind === "help") {
    return { exitCode: 0, stdout: HELP_TEXT, stderr: "" };
  }

  if (parsed.kind === "version") {
    return { exitCode: 0, stdout: `${VERSION}\n`, stderr: "" };
  }

  if (parsed.kind === "error") {
    return usageError(parsed.message);
  }

  const cwd = dependencies.cwd ?? process.cwd();
  const environment = dependencies.environment ?? process.env;
  const envResult = loadOptionalEnv(resolve(cwd, ".env"), dependencies.loadEnvFile ?? process.loadEnvFile);

  if (envResult !== undefined) {
    return usageError(envResult);
  }

  let config: ResolvedConfig;

  try {
    config = await (dependencies.loadConfig ?? loadConfig)({ cwd, ...(parsed.configPath === undefined ? {} : { configPath: parsed.configPath }), environment });
  } catch (error: unknown) {
    if (error instanceof SdiConfigError) {
      return usageError("SDI_CONFIG_INVALID: Configuration could not be loaded.");
    }

    throw error;
  }

  const outcome = parsed.kind === "baseline"
    ? await (dependencies.runBaseline ?? runBaseline)({ config, mode: "baseline", confirmed: parsed.confirmed, clearStaleLock: parsed.clearStaleLock })
    : parsed.dryRun
      ? await (dependencies.runDryRun ?? runDryRun)({ config, mode: "dry-run", clearStaleLock: parsed.clearStaleLock })
      : await (dependencies.runLive ?? runLive)({
          config,
          mode: "live",
          force: parsed.force,
          allowLargeDelete: parsed.allowLargeDelete,
          clearStaleLock: parsed.clearStaleLock,
        });

  return presentOutcome(outcome);
}

function parseCommand(args: readonly string[]): ParsedCommand {
  if (args.length === 0 || (args.length === 1 && (args[0] === "--help" || args[0] === "-h"))) {
    return { kind: "help" };
  }

  if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) {
    return { kind: "version" };
  }

  const [command, ...flags] = args;

  if (command !== "run" && command !== "baseline") {
    return { kind: "error", message: "SDI_USAGE_INVALID: Expected 'run' or 'baseline'." };
  }

  const seen = new Set<string>();
  let configPath: string | undefined;
  let dryRun = false;
  let force = false;
  let allowLargeDelete = false;
  let clearStaleLock = false;
  let confirmed = false;

  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];

    if (flag === "--config") {
      if (seen.has(flag) || index + 1 >= flags.length || flags[index + 1].startsWith("-")) {
        return { kind: "error", message: "SDI_USAGE_INVALID: --config requires one path." };
      }

      seen.add(flag);
      configPath = flags[index + 1];
      index += 1;
      continue;
    }

    if (!["--dry-run", "--force", "--allow-large-delete", "--clear-stale-lock", "--confirm"].includes(flag) || seen.has(flag)) {
      return { kind: "error", message: `SDI_USAGE_INVALID: Invalid or repeated flag '${flag}'.` };
    }

    seen.add(flag);
    dryRun ||= flag === "--dry-run";
    force ||= flag === "--force";
    allowLargeDelete ||= flag === "--allow-large-delete";
    clearStaleLock ||= flag === "--clear-stale-lock";
    confirmed ||= flag === "--confirm";
  }

  if (command === "baseline") {
    if (dryRun || force || allowLargeDelete) {
      return { kind: "error", message: "SDI_USAGE_INVALID: baseline does not accept run-only flags." };
    }

    if (!confirmed) {
      return { kind: "error", message: "SDI_USAGE_INVALID: baseline requires --confirm." };
    }

    return { kind: "baseline", configPath, confirmed, clearStaleLock };
  }

  if (confirmed || (dryRun && (force || allowLargeDelete))) {
    return { kind: "error", message: "SDI_USAGE_INVALID: incompatible run flags." };
  }

  return { kind: "run", configPath, dryRun, force, allowLargeDelete, clearStaleLock };
}

function loadOptionalEnv(path: string, loadEnvFile: (path: string) => void): string | undefined {
  try {
    loadEnvFile(path);
    return undefined;
  } catch (error: unknown) {
    if (isMissingFile(error)) {
      return undefined;
    }

    return "SDI_CONFIG_INVALID: Local .env could not be loaded.";
  }
}

function presentOutcome(outcome: RunOutcome): CliExecution {
  const stdout = "report" in outcome && outcome.report !== undefined ? formatReport(outcome.report) : "";
  const stderr = outcome.terminalDiagnostics.map(formatDiagnostic).join("");

  return { exitCode: outcome.exitCode, stdout, stderr };
}

function formatReport(report: ExecutionReport): string {
  const lines = [
    `SDI ${report.mode}: ${report.status}`,
    `Changes: created=${report.changes.created} updated=${report.changes.updated} unchanged=${report.changes.unchanged} deleted=${report.changes.deleted}`,
  ];

  if (report.indexNow !== undefined) {
    lines.push(`IndexNow: accepted=${report.indexNow.accepted} submitted=${report.indexNow.submitted} batches=${report.indexNow.batches} attempts=${report.indexNow.attempts}`);
  }

  lines.push(...report.warnings.map((diagnostic) => `WARNING ${diagnostic.code}: ${diagnostic.message}`));
  lines.push(...report.errors.map((diagnostic) => `ERROR ${diagnostic.code}: ${diagnostic.message}`));
  return `${lines.join("\n")}\n`;
}

function usageError(message: string): CliExecution {
  return { exitCode: 2, stdout: "", stderr: `${message}\n` };
}

function formatDiagnostic(diagnostic: Diagnostic): string {
  return `ERROR ${diagnostic.code}: ${diagnostic.message}\n`;
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isDirectInvocation(): boolean {
  const entryPath = process.argv[1];
  return entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url;
}

if (isDirectInvocation()) {
  void executeCli(process.argv.slice(2)).then((response) => {
    process.stdout.write(response.stdout);
    process.stderr.write(response.stderr);
    process.exitCode = response.exitCode;
  }).catch(() => {
    process.stderr.write("SDI internal failure.\n");
    process.exitCode = 1;
  });
}
