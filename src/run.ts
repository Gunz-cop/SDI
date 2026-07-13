import { randomUUID } from "node:crypto";
import { compareRecords } from "./core/compare.js";
import type { ChangeSet, DiscoveryState, StateStore, UrlRecord } from "./core/types.js";
import type { ResolvedConfig } from "./config.js";
import { toRedactedConfig } from "./config.js";
import { JsonReportWriteError, writeJsonReport } from "./report/jsonReport.js";
import type { Diagnostic, ExecutionReport } from "./report/types.js";
import { AstroBuildSource, AstroBuildSourceError, composeDiscoveredResources, type AstroDiscoveryResult } from "./source/astroBuild.js";
import { FileStateError, FileStateStore, acquireStateLock, getStateLockPath, type StateLockLease } from "./state/fileState.js";
import { SDI_VERSION } from "./version.js";

export type NonEmptyDiagnostics = [Diagnostic, ...Diagnostic[]];

export type RunOutcome =
  | {
      kind: "success";
      exitCode: 0;
      report: ExecutionReport;
      reportWritten: true;
      terminalDiagnostics: [];
    }
  | ({
      kind: "operational-failure";
      exitCode: 1;
    } & (
      | { report: ExecutionReport; reportWritten: true; terminalDiagnostics: Diagnostic[] }
      | { report: ExecutionReport; reportWritten: false; terminalDiagnostics: NonEmptyDiagnostics }
      | { report?: never; reportWritten: false; terminalDiagnostics: NonEmptyDiagnostics }
    ))
  | {
      kind: "usage-error";
      exitCode: 2;
      report?: never;
      reportWritten: false;
      terminalDiagnostics: NonEmptyDiagnostics;
    };

export interface DryRunOptions {
  config: ResolvedConfig;
  mode: "dry-run";
}

interface ReadOnlyRunDependencies {
  now?: () => Date;
  runId?: () => string;
  sdiVersion?: string;
  createSource?: (config: ResolvedConfig) => AstroDiscoverySource;
  createStateStore?: (config: ResolvedConfig) => Pick<StateStore, "load">;
  acquireLock?: (config: ResolvedConfig) => Promise<StateLockLease>;
  writeReport?: (report: ExecutionReport, reportPath: string) => Promise<void>;
}

interface AstroDiscoverySource {
  discoverWithMetadata(): Promise<AstroDiscoveryResult>;
}

const EMPTY_SOURCE = { sitemapUsed: false, discovered: 0, rejected: 0, duplicates: 0 } as const;
const EMPTY_CHANGES: ExecutionReport["changes"] = { created: 0, updated: 0, unchanged: 0, deleted: 0 };
const EMPTY_CHANGE_URLS: ExecutionReport["changeUrls"] = { created: [], updated: [], deleted: [] };

/** Executes the read-only dry-run slice of SDI's runner without touching process state or the state file. */
export async function runDryRun(options: DryRunOptions, dependencies: ReadOnlyRunDependencies = {}): Promise<RunOutcome> {
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now();
  const runId = (dependencies.runId ?? randomUUID)();
  const version = dependencies.sdiVersion ?? SDI_VERSION;
  const warnings: Diagnostic[] = [];
  const errors: Diagnostic[] = [];
  let source: ExecutionReport["source"] = { ...EMPTY_SOURCE };
  let changes: ChangeSet | undefined;
  let lease: StateLockLease | undefined;
  let report: ExecutionReport | undefined;
  let reportWritten = false;
  const terminalDiagnostics: Diagnostic[] = [];

  try {
    try {
      lease = await (dependencies.acquireLock?.(options.config) ?? acquireDefaultLock(options.config));
    } catch (error: unknown) {
      return lockFailure(error);
    }

    try {
      const state = await (dependencies.createStateStore?.(options.config) ?? createDefaultStateStore(options.config)).load();
      const discovery = await (dependencies.createSource?.(options.config) ?? createDefaultSource(options.config)).discoverWithMetadata();
      const records = await composeDiscoveredResources(discovery.resources, {
        siteUrl: options.config.siteUrl,
        trailingSlash: options.config.normalization.trailingSlash,
      });

      source = {
        sitemapUsed: discovery.sitemapUsed,
        discovered: discovery.resources.length,
        rejected: 0,
        duplicates: discovery.resources.length - records.length,
      };

      if (records.length === 0) {
        errors.push(diagnostic("SDI_SOURCE_EMPTY", "The discovered inventory is empty."));
      } else {
        changes = compareRecords(state?.resources ?? {}, recordsByUrl(records));

        if (state === null) {
          warnings.push(diagnostic("SDI_BASELINE_REQUIRED", "A baseline is required before a live run."));
        }

        if (isLargeDelete(changes, state)) {
          warnings.push(diagnostic("SDI_LARGE_DELETE", "The dry-run detected a deletion greater than 50 percent of the previous inventory."));
        }
      }
    } catch (error: unknown) {
      errors.push(diagnosticForWorkError(error));
    }

    report = buildReport({
      config: options.config,
      runId,
      version,
      startedAt,
      finishedAt: now(),
      source,
      changes,
      warnings,
      errors,
    });

    try {
      await (dependencies.writeReport?.(report, options.config.reportPath) ?? writeJsonReport(report, { reportPath: options.config.reportPath }));
      reportWritten = true;
    } catch (error: unknown) {
      if (!(error instanceof JsonReportWriteError)) {
        throw error;
      }

      terminalDiagnostics.push(diagnostic("SDI_REPORT_WRITE_FAILED", "The JSON report could not be written."));
    }
  } finally {
    if (lease !== undefined) {
      try {
        await lease.release();
      } catch {
        terminalDiagnostics.push(diagnostic("SDI_LOCK_RELEASE_FAILED", "The execution lock could not be released."));
      }
    }
  }

  if (report === undefined) {
    throw new Error("Dry-run completed without a report.");
  }

  if (report.status === "success" && reportWritten && terminalDiagnostics.length === 0) {
    return { kind: "success", exitCode: 0, report, reportWritten: true, terminalDiagnostics: [] };
  }

  if (reportWritten) {
    return {
      kind: "operational-failure",
      exitCode: 1,
      report,
      reportWritten: true,
      terminalDiagnostics,
    };
  }

  return {
    kind: "operational-failure",
    exitCode: 1,
    report,
    reportWritten: false,
    terminalDiagnostics: terminalDiagnostics as NonEmptyDiagnostics,
  };
}

function createDefaultSource(config: ResolvedConfig): AstroBuildSource {
  return new AstroBuildSource({
    siteUrl: config.siteUrl,
    distDir: config.source.distDir,
    sitemapPath: config.source.sitemapPath,
    fallbackToHtmlScan: config.source.fallbackToHtmlScan,
  });
}

function createDefaultStateStore(config: ResolvedConfig): FileStateStore {
  return new FileStateStore({
    statePath: config.statePath,
    legacyStatePath: config.legacyStatePath,
    siteId: config.siteId,
    siteUrl: config.siteUrl,
    trailingSlash: config.normalization.trailingSlash,
  });
}

function acquireDefaultLock(config: ResolvedConfig): Promise<StateLockLease> {
  return acquireStateLock({ lockPath: getStateLockPath(config.statePath), siteId: config.siteId });
}

function recordsByUrl(records: UrlRecord[]): Record<string, UrlRecord> {
  return Object.fromEntries(records.map((record) => [record.url, record]));
}

function isLargeDelete(changes: ChangeSet, state: DiscoveryState | null): boolean {
  if (state === null) {
    return false;
  }

  const previousCount = Object.keys(state.resources).length;
  return previousCount > 0 && changes.deleted.length / previousCount > 0.5;
}

function buildReport(input: {
  config: ResolvedConfig;
  runId: string;
  version: string;
  startedAt: Date;
  finishedAt: Date;
  source: ExecutionReport["source"];
  changes: ChangeSet | undefined;
  warnings: Diagnostic[];
  errors: Diagnostic[];
}): ExecutionReport {
  const finishedMs = Math.max(input.startedAt.getTime(), input.finishedAt.getTime());
  const finishedAt = new Date(finishedMs);
  const changes = input.changes;

  return {
    schemaVersion: 1,
    runId: input.runId,
    sdiVersion: input.version,
    siteId: input.config.siteId,
    mode: "dry-run",
    status: input.errors.length === 0 ? "success" : "failed",
    startedAt: input.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedMs - input.startedAt.getTime(),
    source: input.source,
    changes: changes === undefined ? { ...EMPTY_CHANGES } : countsFor(changes),
    changeUrls: changes === undefined ? { ...EMPTY_CHANGE_URLS } : urlsFor(changes),
    warnings: input.warnings,
    errors: input.errors,
    config: toRedactedConfig(input.config),
  };
}

function countsFor(changes: ChangeSet): ExecutionReport["changes"] {
  return {
    created: changes.created.length,
    updated: changes.updated.length,
    unchanged: changes.unchanged.length,
    deleted: changes.deleted.length,
  };
}

function urlsFor(changes: ChangeSet): ExecutionReport["changeUrls"] {
  return {
    created: changes.created.map((record) => record.url),
    updated: changes.updated.map((change) => change.after.url),
    deleted: changes.deleted.map((record) => record.url),
  };
}

function diagnosticForWorkError(error: unknown): Diagnostic {
  if (error instanceof FileStateError) {
    if (error.code === "state-incompatible") {
      return diagnostic("SDI_STATE_INCOMPATIBLE", "The stored state is incompatible with the configured site.");
    }

    return diagnostic("SDI_STATE_CORRUPT", "The stored state could not be loaded safely.");
  }

  if (error instanceof AstroBuildSourceError) {
    return diagnostic("SDI_SOURCE_FAILED", "The static build source could not produce a complete inventory.");
  }

  throw error;
}

function lockFailure(error: unknown): RunOutcome {
  if (error instanceof Error && "code" in error) {
    const code = error.code;

    if (code === "lock-active") {
      return failureWithoutReport(diagnostic("SDI_LOCKED", "Another SDI execution already owns the state lock."));
    }

    if (code === "lock-stale") {
      return failureWithoutReport(diagnostic("SDI_LOCK_STALE", "A stale SDI state lock requires explicit cleanup."));
    }

    if (code === "lock-invalid") {
      return failureWithoutReport(diagnostic("SDI_LOCK_INVALID", "The existing SDI state lock is invalid."));
    }
  }

  throw error;
}

function failureWithoutReport(diagnosticValue: Diagnostic): RunOutcome {
  return {
    kind: "operational-failure",
    exitCode: 1,
    reportWritten: false,
    terminalDiagnostics: [diagnosticValue],
  };
}

function diagnostic(code: string, message: string): Diagnostic {
  return { code, message };
}
