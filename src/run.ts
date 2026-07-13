import { randomUUID } from "node:crypto";
import { compareRecords } from "./core/compare.js";
import { FINGERPRINT_PROFILE } from "./core/fingerprint.js";
import type { ChangeSet, Destination, DiscoveryState, PublishResult, StateStore, UrlRecord } from "./core/types.js";
import type { ResolvedConfig } from "./config.js";
import { toRedactedConfig } from "./config.js";
import { JsonReportWriteError, writeJsonReport } from "./report/jsonReport.js";
import type { Diagnostic, ExecutionReport } from "./report/types.js";
import { AstroBuildSource, AstroBuildSourceError, composeDiscoveredResources, type AstroDiscoveryResult } from "./source/astroBuild.js";
import { IndexNowDestination } from "./destination/indexNow.js";
import { FileStateError, FileStateStore, StateLockError, acquireStateLock, getStateLockPath, removeStaleLock, type StateLockLease, type StateLockOptions } from "./state/fileState.js";
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

export interface BaselineOptions {
  config: ResolvedConfig;
  mode: "baseline";
  confirmed: boolean;
}

export interface LiveOptions {
  config: ResolvedConfig;
  mode: "live";
  force: boolean;
  allowLargeDelete: boolean;
  clearStaleLock: boolean;
}

interface ReadOnlyRunDependencies {
  now?: () => Date;
  runId?: () => string;
  sdiVersion?: string;
  createSource?: (config: ResolvedConfig) => AstroDiscoverySource;
  createStateStore?: (config: ResolvedConfig) => StateStore;
  acquireLock?: (config: ResolvedConfig) => Promise<StateLockLease>;
  createDestination?: (config: ResolvedConfig) => Pick<Destination, "publish">;
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
      mode: options.mode,
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

  return outcomeFor(report, reportWritten, terminalDiagnostics);
}

/** Saves an initial inventory only when no safe current or legacy state exists. */
export async function runBaseline(options: BaselineOptions, dependencies: ReadOnlyRunDependencies = {}): Promise<RunOutcome> {
  if (!options.confirmed) {
    return {
      kind: "usage-error",
      exitCode: 2,
      reportWritten: false,
      terminalDiagnostics: [diagnostic("SDI_USAGE_INVALID", "Baseline requires explicit confirmation.")],
    };
  }

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
      const stateStore = dependencies.createStateStore?.(options.config) ?? createDefaultStateStore(options.config);
      const state = await stateStore.load();

      if (state !== null) {
        errors.push(diagnostic("SDI_BASELINE_EXISTS", "Baseline cannot replace an existing state."));
      } else {
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
          changes = compareRecords({}, recordsByUrl(records));
          await stateStore.save({
            schemaVersion: 1,
            siteId: options.config.siteId,
            siteUrl: options.config.siteUrl,
            trailingSlash: options.config.normalization.trailingSlash,
            fingerprintProfile: FINGERPRINT_PROFILE,
            updatedAt: now().toISOString(),
            resources: recordsByUrl(records),
          });
        }
      }
    } catch (error: unknown) {
      errors.push(diagnosticForWorkError(error));
    }

    report = buildReport({
      config: options.config,
      mode: options.mode,
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
    throw new Error("Baseline completed without a report.");
  }

  return outcomeFor(report, reportWritten, terminalDiagnostics);
}

/** Publishes a complete live change set and advances state only after IndexNow accepts it. */
export async function runLive(options: LiveOptions, dependencies: ReadOnlyRunDependencies = {}): Promise<RunOutcome> {
  if (options.config.indexNow?.key === undefined) {
    return usageFailure("SDI_CONFIG_INVALID", "Live runs require a configured IndexNow key.");
  }

  const now = dependencies.now ?? (() => new Date());
  const startedAt = now();
  const runId = (dependencies.runId ?? randomUUID)();
  const version = dependencies.sdiVersion ?? SDI_VERSION;
  const warnings: Diagnostic[] = options.force
    ? [diagnostic("SDI_FORCE_ENABLED", "Force publishing is enabled for this live run.")]
    : [];
  const errors: Diagnostic[] = [];
  let source: ExecutionReport["source"] = { ...EMPTY_SOURCE };
  let changes: ChangeSet | undefined;
  let publishResult: PublishResult | undefined;
  let lease: StateLockLease | undefined;
  let report: ExecutionReport | undefined;
  let reportWritten = false;
  const terminalDiagnostics: Diagnostic[] = [];

  try {
    try {
      lease = await acquireLiveLock(options, dependencies);
    } catch (error: unknown) {
      return lockFailure(error);
    }

    try {
      const stateStore = dependencies.createStateStore?.(options.config) ?? createDefaultStateStore(options.config);
      const state = await stateStore.load();

      if (state === null) {
        errors.push(diagnostic("SDI_BASELINE_REQUIRED", "A baseline is required before a live run."));
      } else {
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
          changes = compareRecords(state.resources, recordsByUrl(records));

          if (isLargeDelete(changes, state)) {
            if (options.allowLargeDelete) {
              warnings.push(diagnostic("SDI_LARGE_DELETE_ALLOWED", "The large deletion was explicitly authorized."));
            } else {
              errors.push(diagnostic("SDI_LARGE_DELETE", "The live run detected a deletion greater than 50 percent of the previous inventory."));
            }
          }

          if (errors.length === 0) {
            const publication = publicationProjection(changes, options.force);

            if (hasPublishableUrls(publication)) {
              publishResult = await (dependencies.createDestination?.(options.config) ?? createDefaultDestination(options.config)).publish(publication);

              if (!publishResult.accepted) {
                errors.push(diagnosticForPublishFailure(publishResult));
              }
            }

            if (errors.length === 0 && stateChanged(changes)) {
              await stateStore.save(nextState(options.config, records, now()));
            }
          }
        }
      }
    } catch (error: unknown) {
      errors.push(diagnosticForWorkError(error));
    }

    report = buildReport({
      config: options.config,
      mode: options.mode,
      runId,
      version,
      startedAt,
      finishedAt: now(),
      source,
      changes,
      warnings,
      errors,
      indexNow: publishResult === undefined ? undefined : indexNowSummary(publishResult),
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
    throw new Error("Live run completed without a report.");
  }

  return outcomeFor(report, reportWritten, terminalDiagnostics);
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

async function acquireLiveLock(options: LiveOptions, dependencies: ReadOnlyRunDependencies): Promise<StateLockLease> {
  try {
    return await (dependencies.acquireLock?.(options.config) ?? acquireDefaultLock(options.config));
  } catch (error: unknown) {
    if (!options.clearStaleLock || !(error instanceof StateLockError) || error.code !== "lock-stale" || error.inspection === undefined) {
      throw error;
    }

    const lockOptions = defaultLockOptions(options.config);
    const removed = await removeStaleLock(error.inspection, lockOptions);

    if (!removed) {
      throw new StateLockError("lock-remove-failed", "The stale state lock could not be cleared.", error.inspection);
    }

    return acquireStateLock(lockOptions);
  }
}

function defaultLockOptions(config: ResolvedConfig): StateLockOptions {
  return { lockPath: getStateLockPath(config.statePath), siteId: config.siteId };
}

function createDefaultDestination(config: ResolvedConfig): IndexNowDestination {
  const indexNow = config.indexNow;

  if (indexNow?.key === undefined) {
    throw new Error("Live destination requires an IndexNow key.");
  }

  return new IndexNowDestination({
    host: new URL(config.siteUrl).host,
    key: indexNow.key,
    ...(indexNow.keyLocation === undefined ? {} : { keyLocation: indexNow.keyLocation }),
  });
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
  mode: ExecutionReport["mode"];
  runId: string;
  version: string;
  startedAt: Date;
  finishedAt: Date;
  source: ExecutionReport["source"];
  changes: ChangeSet | undefined;
  warnings: Diagnostic[];
  errors: Diagnostic[];
  indexNow?: ExecutionReport["indexNow"];
}): ExecutionReport {
  const finishedMs = Math.max(input.startedAt.getTime(), input.finishedAt.getTime());
  const finishedAt = new Date(finishedMs);
  const changes = input.changes;

  return {
    schemaVersion: 1,
    runId: input.runId,
    sdiVersion: input.version,
    siteId: input.config.siteId,
    mode: input.mode,
    status: input.errors.length === 0 ? "success" : "failed",
    startedAt: input.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedMs - input.startedAt.getTime(),
    source: input.source,
    changes: changes === undefined ? { ...EMPTY_CHANGES } : countsFor(changes),
    changeUrls: changes === undefined ? { ...EMPTY_CHANGE_URLS } : urlsFor(changes),
    ...(input.indexNow === undefined ? {} : { indexNow: input.indexNow }),
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

    if (error.code === "state-save-failed" || error.code === "state-save-rollback-failed") {
      return diagnostic("SDI_STATE_WRITE_FAILED", "The state could not be saved safely.");
    }

    return diagnostic("SDI_STATE_CORRUPT", "The stored state could not be loaded safely.");
  }

  if (error instanceof AstroBuildSourceError) {
    return diagnostic("SDI_SOURCE_FAILED", "The static build source could not produce a complete inventory.");
  }

  throw error;
}

function publicationProjection(changes: ChangeSet, force: boolean): ChangeSet {
  if (!force) {
    return changes;
  }

  return {
    created: changes.created,
    updated: [
      ...changes.updated,
      ...changes.unchanged.map((record) => ({ before: record, after: record })),
    ],
    unchanged: [],
    deleted: changes.deleted,
  };
}

function hasPublishableUrls(changes: ChangeSet): boolean {
  return changes.created.length + changes.updated.length + changes.deleted.length > 0;
}

function stateChanged(changes: ChangeSet): boolean {
  return changes.created.length + changes.updated.length + changes.deleted.length > 0;
}

function nextState(config: ResolvedConfig, records: UrlRecord[], updatedAt: Date): DiscoveryState {
  return {
    schemaVersion: 1,
    siteId: config.siteId,
    siteUrl: config.siteUrl,
    trailingSlash: config.normalization.trailingSlash,
    fingerprintProfile: FINGERPRINT_PROFILE,
    updatedAt: updatedAt.toISOString(),
    resources: recordsByUrl(records),
  };
}

function indexNowSummary(result: PublishResult): NonNullable<ExecutionReport["indexNow"]> {
  return {
    submitted: result.submittedUrls,
    batches: result.batches.length,
    attempts: result.batches.reduce((total, batch) => total + batch.attempts, 0),
    accepted: result.accepted,
  };
}

function diagnosticForPublishFailure(result: PublishResult): Diagnostic {
  const batch = result.batches.at(-1);

  if (batch?.status === null) {
    return diagnostic(`INDEXNOW_${batch.failure.toUpperCase()}`, "IndexNow did not return an HTTP response.");
  }

  if (batch?.status !== undefined) {
    return diagnostic(`INDEXNOW_HTTP_${batch.status}`, "IndexNow rejected a publish batch.");
  }

  throw new Error("Rejected IndexNow publish result must contain a batch.");
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

    if (code === "lock-remove-failed") {
      return failureWithoutReport(diagnostic("SDI_LOCK_CLEAR_FAILED", "The stale SDI state lock could not be cleared."));
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

function usageFailure(code: string, message: string): RunOutcome {
  return {
    kind: "usage-error",
    exitCode: 2,
    reportWritten: false,
    terminalDiagnostics: [diagnostic(code, message)],
  };
}

function outcomeFor(report: ExecutionReport, reportWritten: boolean, terminalDiagnostics: Diagnostic[]): RunOutcome {
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

function diagnostic(code: string, message: string): Diagnostic {
  return { code, message };
}
