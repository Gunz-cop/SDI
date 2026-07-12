import { describe, expect, it, vi } from "vitest";
import { JsonReportValidationError, JsonReportWriteError, validateExecutionReport, writeJsonReport } from "../../src/report/jsonReport.js";
import type { ExecutionReport } from "../../src/report/types.js";

function report(): ExecutionReport {
  return { schemaVersion: 1, runId: "run-1", sdiVersion: "0.1.0", siteId: "site", mode: "live", status: "success", startedAt: "2026-07-12T00:00:00.000Z", finishedAt: "2026-07-12T00:00:01.000Z", durationMs: 1_000,
    source: { sitemapUsed: true, discovered: 2, rejected: 0, duplicates: 0 }, changes: { created: 1, updated: 1, unchanged: 0, deleted: 1 }, changeUrls: { created: ["https://example.com/a"], updated: ["https://example.com/b"], deleted: ["https://example.com/c"] }, indexNow: { submitted: 3, batches: 1, attempts: 1, accepted: true }, warnings: [{ code: "SDI_WARNING", message: "warning" }], errors: [],
    config: { siteId: "site", siteUrl: "https://example.com", source: { distDir: "dist", sitemapPath: "dist/sitemap.xml", fallbackToHtmlScan: true }, normalization: { trailingSlash: "always" }, statePath: ".sdi/state.json", reportPath: ".sdi/last-run.json", indexNow: { keyEnv: "INDEXNOW_KEY" } } };
}

describe("json report", () => {
  it("validates a complete report and permits optional report fields to be absent", () => {
    const value = report(); delete value.indexNow; delete value.config.indexNow;
    expect(() => validateExecutionReport(value)).not.toThrow();
  });

  it.each([
    (value: ExecutionReport) => ({ ...value, extra: true }),
    (value: ExecutionReport) => ({ ...value, warnings: [{ code: "bad", message: "x" }] }),
    (value: ExecutionReport) => ({ ...value, finishedAt: "2026-07-11T00:00:00.000Z" }),
    (value: ExecutionReport) => ({ ...value, durationMs: -1 }),
    (value: ExecutionReport) => ({ ...value, changeUrls: { ...value.changeUrls, created: ["invalid"] } }),
    (value: ExecutionReport) => ({ ...value, changeUrls: { ...value.changeUrls, created: ["https://example.com/z", "https://example.com/a"] }, changes: { ...value.changes, created: 2 } }),
    (value: ExecutionReport) => ({ ...value, config: { ...value.config, siteId: "other" } }),
    (value: ExecutionReport) => ({ ...value, config: { ...value.config, indexNow: { keyEnv: "ENV", key: "secret" } } }),
  ])("rejects invalid report invariants", (change) => {
    expect(() => validateExecutionReport(change(report()))).toThrow(JsonReportValidationError);
  });

  it("writes stable JSON, flushes, and promotes a temporary report", async () => {
    const writeFile = vi.fn(async () => undefined); const sync = vi.fn(async () => undefined); const close = vi.fn(async () => undefined); const mkdir = vi.fn(async () => undefined); const rename = vi.fn(async () => undefined);
    await writeJsonReport(report(), { reportPath: "reports/last-run.json", filesystem: { mkdir, open: async () => ({ writeFile, sync, close }), rename, rm: async () => undefined } });
    expect(mkdir).toHaveBeenCalled(); expect(sync).toHaveBeenCalledOnce(); expect(rename).toHaveBeenCalledWith("reports/last-run.json.tmp", "reports/last-run.json");
    const contents = String(writeFile.mock.calls[0]?.[0]);
    expect(contents).toMatch(/^\{\n {2}"schemaVersion": 1,\n {2}"runId": "run-1",/); expect(contents.endsWith("\n")).toBe(true);
  });

  it("does not touch the filesystem for invalid reports and wraps write failures", async () => {
    const mkdir = vi.fn(async () => undefined); const open = vi.fn(async () => { throw new Error("disk"); }); const rm = vi.fn(async () => { throw new Error("cleanup"); });
    await expect(writeJsonReport({ ...report(), durationMs: -1 }, { reportPath: "x.json", filesystem: { mkdir, open, rm } })).rejects.toBeInstanceOf(JsonReportValidationError);
    expect(mkdir).not.toHaveBeenCalled();
    await expect(writeJsonReport(report(), { reportPath: "x.json", filesystem: { mkdir, open, rm } })).rejects.toBeInstanceOf(JsonReportWriteError);
  });

  it("keeps the publish/state commit boundary in a test-only harness", async () => {
    const save = vi.fn(async () => undefined);
    const write = vi.fn(async () => undefined);
    await testOnlyCommitHarness(true, save, write);
    expect(save).toHaveBeenCalledOnce();

    save.mockClear();
    await testOnlyCommitHarness(false, save, write);
    expect(save).not.toHaveBeenCalled();

    await expect(testOnlyCommitHarness(true, save, async () => { throw new Error("report unavailable"); })).rejects.toThrow("report unavailable");
    expect(save).toHaveBeenCalledOnce();
  });
});

async function testOnlyCommitHarness(
  accepted: boolean,
  save: () => Promise<void>,
  write: () => Promise<void>,
): Promise<void> {
  if (accepted) await save();
  await write();
}
