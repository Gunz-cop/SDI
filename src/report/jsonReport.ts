import { mkdir, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { Diagnostic, ExecutionReport, RedactedConfig } from "./types.js";

type Handle = { writeFile(contents: string, encoding: "utf8"): Promise<void>; sync(): Promise<void>; close(): Promise<void> };
export interface JsonReportWriterOptions {
  reportPath: string;
  tempName?: () => string;
  filesystem?: Partial<{
    mkdir(path: string, options: { recursive: true }): Promise<unknown>;
    open(path: string, flags: "wx"): Promise<Handle>;
    rename(from: string, to: string): Promise<void>;
    rm(path: string, options: { force: true }): Promise<void>;
  }>;
}

export class JsonReportValidationError extends Error { constructor(message: string) { super(message); this.name = "JsonReportValidationError"; } }
export class JsonReportWriteError extends Error { constructor(message: string, options?: { cause?: unknown }) { super(message, options); this.name = "JsonReportWriteError"; } }

export async function writeJsonReport(report: ExecutionReport, options: JsonReportWriterOptions): Promise<void> {
  validateExecutionReport(report);
  const serialized = `${JSON.stringify(orderedReport(report), null, 2)}\n`;
  const tempPath = `${options.reportPath}.${(options.tempName ?? randomUUID)()}.tmp`;
  const fs = options.filesystem;
  try {
    await (fs?.mkdir?.(dirname(options.reportPath), { recursive: true }) ?? mkdir(dirname(options.reportPath), { recursive: true }));
    const handle = await (fs?.open?.(tempPath, "wx") ?? open(tempPath, "wx"));
    let operationError: unknown;
    try { await handle.writeFile(serialized, "utf8"); await handle.sync(); } catch (error) { operationError = error; }
    try { await handle.close(); } catch (error) { operationError ??= error; }
    if (operationError !== undefined) throw operationError;
    await (fs?.rename?.(tempPath, options.reportPath) ?? rename(tempPath, options.reportPath));
  } catch (error) {
    try { await (fs?.rm?.(tempPath, { force: true }) ?? rm(tempPath, { force: true })); } catch { /* preserve the primary failure */ }
    throw new JsonReportWriteError(`Could not write JSON report: ${options.reportPath}`, { cause: error });
  }
}

export function validateExecutionReport(value: unknown): asserts value is ExecutionReport {
  const report = object(value, "report");
  exact(report, ["schemaVersion", "runId", "sdiVersion", "siteId", "mode", "status", "startedAt", "finishedAt", "durationMs", "source", "changes", "changeUrls", "indexNow", "warnings", "errors", "config"], ["indexNow"]);
  if (report.schemaVersion !== 1) invalid("schemaVersion must be 1");
  strings(report, ["runId", "sdiVersion", "siteId"]);
  if (!isEnum(report.mode, ["live", "dry-run", "baseline"]) || !isEnum(report.status, ["success", "failed"])) invalid("mode or status is invalid");
  const started = timestamp(report.startedAt, "startedAt"); const finished = timestamp(report.finishedAt, "finishedAt");
  if (finished < started) invalid("finishedAt precedes startedAt");
  integer(report.durationMs, "durationMs");
  counters(object(report.source, "source"), ["sitemapUsed"], ["discovered", "rejected", "duplicates"]);
  counters(object(report.changes, "changes"), [], ["created", "updated", "unchanged", "deleted"]);
  const urls = object(report.changeUrls, "changeUrls"); exact(urls, ["created", "updated", "deleted"]); ["created", "updated", "deleted"].forEach((key) => urlList(urls[key], `changeUrls.${key}`));
  const changes = report.changes as Record<string, unknown>;
  if ((urls.created as unknown[]).length !== changes.created || (urls.updated as unknown[]).length !== changes.updated || (urls.deleted as unknown[]).length !== changes.deleted) invalid("change URL counts do not match");
  if (report.indexNow !== undefined) counters(object(report.indexNow, "indexNow"), ["accepted"], ["submitted", "batches", "attempts"]);
  diagnostics(report.warnings, "warnings"); diagnostics(report.errors, "errors"); validateConfig(report.config);
  if (report.siteId !== (report.config as RedactedConfig).siteId) invalid("report siteId must match config siteId");
}

function orderedReport(r: ExecutionReport): ExecutionReport {
  return { schemaVersion: r.schemaVersion, runId: r.runId, sdiVersion: r.sdiVersion, siteId: r.siteId, mode: r.mode, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, durationMs: r.durationMs,
    source: { sitemapUsed: r.source.sitemapUsed, discovered: r.source.discovered, rejected: r.source.rejected, duplicates: r.source.duplicates }, changes: { created: r.changes.created, updated: r.changes.updated, unchanged: r.changes.unchanged, deleted: r.changes.deleted }, changeUrls: { created: r.changeUrls.created, updated: r.changeUrls.updated, deleted: r.changeUrls.deleted },
    ...(r.indexNow === undefined ? {} : { indexNow: { submitted: r.indexNow.submitted, batches: r.indexNow.batches, attempts: r.indexNow.attempts, accepted: r.indexNow.accepted } }), warnings: r.warnings.map(diagnostic), errors: r.errors.map(diagnostic), config: orderedConfig(r.config) };
}
function orderedConfig(c: RedactedConfig): RedactedConfig { return { siteId: c.siteId, siteUrl: c.siteUrl, source: { distDir: c.source.distDir, sitemapPath: c.source.sitemapPath, fallbackToHtmlScan: c.source.fallbackToHtmlScan }, normalization: { trailingSlash: c.normalization.trailingSlash }, statePath: c.statePath, ...(c.legacyStatePath === undefined ? {} : { legacyStatePath: c.legacyStatePath }), reportPath: c.reportPath, ...(c.indexNow === undefined ? {} : { indexNow: { keyEnv: c.indexNow.keyEnv, ...(c.indexNow.keyLocation === undefined ? {} : { keyLocation: c.indexNow.keyLocation }) } }) }; }
function diagnostic(d: Diagnostic): Diagnostic { return { code: d.code, message: d.message }; }
function validateConfig(value: unknown): asserts value is RedactedConfig { const c = object(value, "config"); exact(c, ["siteId", "siteUrl", "source", "normalization", "statePath", "legacyStatePath", "reportPath", "indexNow"], ["legacyStatePath", "indexNow"]); strings(c, ["siteId", "siteUrl", "statePath", "reportPath"]); url(c.siteUrl, "config.siteUrl"); const source = object(c.source, "config.source"); exact(source, ["distDir", "sitemapPath", "fallbackToHtmlScan"]); strings(source, ["distDir", "sitemapPath"]); if (typeof source.fallbackToHtmlScan !== "boolean") invalid("config source invalid"); const normalization = object(c.normalization, "config.normalization"); exact(normalization, ["trailingSlash"]); if (!isEnum(normalization.trailingSlash, ["preserve", "always", "never"])) invalid("config trailingSlash invalid"); if (c.legacyStatePath !== undefined) string(c.legacyStatePath, "legacyStatePath"); if (c.indexNow !== undefined) { const index = object(c.indexNow, "config.indexNow"); exact(index, ["keyEnv", "keyLocation"], ["keyLocation"]); string(index.keyEnv, "keyEnv"); if (index.keyLocation !== undefined) string(index.keyLocation, "keyLocation"); } }
function diagnostics(value: unknown, name: string): void { if (!Array.isArray(value)) invalid(`${name} must be an array`); value.forEach((entry) => { const d = object(entry, name); exact(d, ["code", "message"]); string(d.code, "diagnostic code"); if (!/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(d.code)) invalid("diagnostic code invalid"); string(d.message, "diagnostic message"); }); }
function counters(value: Record<string, unknown>, booleans: string[], integers: string[]): void { exact(value, [...booleans, ...integers]); booleans.forEach((key) => { if (typeof value[key] !== "boolean") invalid(`${key} invalid`); }); integers.forEach((key) => integer(value[key], key)); }
function urlList(value: unknown, name: string): void { if (!Array.isArray(value)) invalid(`${name} must be an array`); let previous: string | undefined; const seen = new Set<string>(); value.forEach((entry) => { string(entry, name); url(entry, name); if (seen.has(entry) || (previous !== undefined && previous > entry)) invalid(`${name} must be sorted and unique`); seen.add(entry); previous = entry; }); }
/** Reports use Date#toISOString() UTC timestamps so serialisation remains deterministic in 0.1. */
function timestamp(value: unknown, name: string): number { string(value, name); const date = new Date(value); if (Number.isNaN(date.getTime()) || date.toISOString() !== value) invalid(`${name} invalid`); return date.getTime(); }
function integer(value: unknown, name: string): void { if (!Number.isInteger(value) || (value as number) < 0) invalid(`${name} must be a non-negative integer`); }
function strings(value: Record<string, unknown>, keys: string[]): void { keys.forEach((key) => string(value[key], key)); }
function string(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || value.trim() === "") invalid(`${name} must be non-empty`); }
function url(value: unknown, name: string): void { try { const parsed = new URL(String(value)); if (parsed.protocol !== "http:" && parsed.protocol !== "https:") invalid(`${name} invalid`); } catch { invalid(`${name} invalid`); } }
function object(value: unknown, name: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${name} must be an object`); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, keys: string[], optional: string[] = []): void { const allowed = new Set(keys); if (Object.keys(value).some((key) => !allowed.has(key)) || keys.some((key) => !optional.includes(key) && !(key in value))) invalid("object shape invalid"); }
function isEnum(value: unknown, values: string[]): boolean { return typeof value === "string" && values.includes(value); }
function invalid(message: string): never { throw new JsonReportValidationError(message); }
