import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../../src/config.js";
import { fingerprintHtml } from "../../src/core/fingerprint.js";
import { runBaseline, runDryRun } from "../../src/run.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("read-only runner", () => {
  it("writes a dry-run report without state or network effects and warns when a baseline is required", async () => {
    const directory = await fixtureDirectory();
    const config = await configFor(directory);

    const outcome = await runDryRun({ config, mode: "dry-run" });

    expect(outcome).toMatchObject({ kind: "success", exitCode: 0, reportWritten: true });
    if (outcome.kind !== "success") {
      throw new Error("dry-run should succeed");
    }

    expect(outcome.report).toMatchObject({
      mode: "dry-run",
      status: "success",
      source: { sitemapUsed: true, discovered: 1, rejected: 0, duplicates: 0 },
      changes: { created: 1, updated: 0, unchanged: 0, deleted: 0 },
      warnings: [{ code: "SDI_BASELINE_REQUIRED" }],
    });
    await expect(readFile(config.reportPath, "utf8")).resolves.toContain("SDI_BASELINE_REQUIRED");
    await expect(access(config.statePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(resolve(directory, ".sdi/run.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a large delete as a dry-run warning while preserving the real changes", async () => {
    const directory = await fixtureDirectory();
    const config = await configFor(directory);
    await mkdir(resolve(directory, ".sdi"), { recursive: true });
    const state = stateWithThreeResources(config);
    await writeFile(config.statePath, JSON.stringify(state, null, 2));

    const outcome = await runDryRun({ config, mode: "dry-run" });

    expect(outcome).toMatchObject({ kind: "success", report: { changes: { created: 0, updated: 0, unchanged: 1, deleted: 2 } } });
    if (outcome.kind !== "success") {
      throw new Error("dry-run should succeed");
    }

    expect(outcome.report.warnings).toContainEqual(expect.objectContaining({ code: "SDI_LARGE_DELETE" }));
    await expect(readFile(config.statePath, "utf8")).resolves.toBe(JSON.stringify(state, null, 2));
  });

  it("fails safely for an empty completed inventory and writes neutral source metrics", async () => {
    const directory = await fixtureDirectory({ emptyInventory: true });
    const config = configFor(directory, true);

    const outcome = await runDryRun({ config, mode: "dry-run" });

    expect(outcome).toMatchObject({
      kind: "operational-failure",
      exitCode: 1,
      reportWritten: true,
      report: { status: "failed", source: { sitemapUsed: false, discovered: 0, rejected: 0, duplicates: 0 }, errors: [{ code: "SDI_SOURCE_EMPTY" }] },
    });
  });

  it("preserves sitemap metadata for a completed empty sitemap inventory", async () => {
    const directory = await fixtureDirectory({ sitemap: emptySitemap() });
    const config = configFor(directory);

    const outcome = await runDryRun({ config, mode: "dry-run" });

    expect(outcome).toMatchObject({
      kind: "operational-failure",
      reportWritten: true,
      report: { source: { sitemapUsed: true, discovered: 0, rejected: 0, duplicates: 0 }, errors: [{ code: "SDI_SOURCE_EMPTY" }] },
    });
    await expect(access(resolve(directory, ".sdi/run.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes a failed report for an Astro sitemap IO error after acquiring the lock", async () => {
    const directory = await fixtureDirectory();
    const config = configFor(directory);
    await rm(config.source.sitemapPath);
    await mkdir(config.source.sitemapPath, { recursive: true });

    const outcome = await runDryRun({ config, mode: "dry-run" });

    expect(outcome).toMatchObject({
      kind: "operational-failure",
      reportWritten: true,
      report: { status: "failed", source: { sitemapUsed: false, discovered: 0, rejected: 0, duplicates: 0 }, errors: [{ code: "SDI_SOURCE_FAILED" }] },
    });
    await expect(access(resolve(directory, ".sdi/run.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes a failed report when compiled HTML becomes unreadable during composition", async () => {
    const directory = await fixtureDirectory();
    const config = configFor(directory);

    const outcome = await runDryRun({ config, mode: "dry-run" }, {
      createSource: () => ({
        discoverWithMetadata: async () => ({
          sitemapUsed: true,
          resources: [{ url: "https://runner.example.test/", filePath: resolve(directory, "vanished.html") }],
        }),
      }),
    });

    expect(outcome).toMatchObject({
      kind: "operational-failure",
      reportWritten: true,
      report: { status: "failed", errors: [{ code: "SDI_SOURCE_FAILED" }] },
    });
    await expect(access(resolve(directory, ".sdi/run.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not overwrite a report when another process owns the lock", async () => {
    const directory = await fixtureDirectory();
    const config = configFor(directory);
    const lockPath = resolve(directory, ".sdi/run.lock");
    await mkdir(resolve(directory, ".sdi"), { recursive: true });
    await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), siteId: config.siteId, hostname: hostname() })}\n`);
    await writeFile(config.reportPath, "previous report");

    const outcome = await runDryRun({ config, mode: "dry-run" });

    expect(outcome).toEqual({
      kind: "operational-failure",
      exitCode: 1,
      reportWritten: false,
      terminalDiagnostics: [{ code: "SDI_LOCKED", message: "Another SDI execution already owns the state lock." }],
    });
    await expect(readFile(config.reportPath, "utf8")).resolves.toBe("previous report");
  });
});

describe("baseline runner", () => {
  it("saves an initial inventory and report without invoking a destination", async () => {
    const directory = await fixtureDirectory();
    const config = configFor(directory);

    const outcome = await runBaseline({ config, mode: "baseline", confirmed: true });

    expect(outcome).toMatchObject({
      kind: "success",
      exitCode: 0,
      reportWritten: true,
      report: { mode: "baseline", status: "success", changes: { created: 1, updated: 0, unchanged: 0, deleted: 0 } },
    });
    const state = JSON.parse(await readFile(config.statePath, "utf8")) as { resources: Record<string, unknown> };
    expect(Object.keys(state.resources)).toEqual(["https://runner.example.test/"]);
    await expect(readFile(config.reportPath, "utf8")).resolves.not.toContain("indexNow");
    await expect(access(resolve(directory, ".sdi/run.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires explicit confirmation before acquiring a lock or writing a report", async () => {
    const directory = await fixtureDirectory();
    const config = configFor(directory);

    const outcome = await runBaseline({ config, mode: "baseline", confirmed: false });

    expect(outcome).toEqual({
      kind: "usage-error",
      exitCode: 2,
      reportWritten: false,
      terminalDiagnostics: [{ code: "SDI_USAGE_INVALID", message: "Baseline requires explicit confirmation." }],
    });
    await expect(access(config.reportPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(resolve(directory, ".sdi/run.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to replace an existing state and reports the operational failure", async () => {
    const directory = await fixtureDirectory();
    const config = configFor(directory);
    await mkdir(resolve(directory, ".sdi"), { recursive: true });
    const state = stateWithThreeResources(config);
    await writeFile(config.statePath, JSON.stringify(state, null, 2));

    const outcome = await runBaseline({ config, mode: "baseline", confirmed: true });

    expect(outcome).toMatchObject({
      kind: "operational-failure",
      exitCode: 1,
      reportWritten: true,
      report: { mode: "baseline", status: "failed", errors: [{ code: "SDI_BASELINE_EXISTS" }] },
    });
    await expect(readFile(config.statePath, "utf8")).resolves.toBe(JSON.stringify(state, null, 2));
    await expect(access(resolve(directory, ".sdi/run.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not save an empty inventory and writes a failed baseline report", async () => {
    const directory = await fixtureDirectory({ emptyInventory: true });
    const config = configFor(directory, true);

    const outcome = await runBaseline({ config, mode: "baseline", confirmed: true });

    expect(outcome).toMatchObject({
      kind: "operational-failure",
      reportWritten: true,
      report: { mode: "baseline", status: "failed", source: { sitemapUsed: false, discovered: 0 }, errors: [{ code: "SDI_SOURCE_EMPTY" }] },
    });
    await expect(access(config.statePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(resolve(directory, ".sdi/run.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function fixtureDirectory(options: { sitemap?: string; emptyInventory?: boolean } = {}): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "sdi-run-"));
  directories.push(directory);
  const dist = resolve(directory, "dist");
  await mkdir(dist, { recursive: true });
  if (!options.emptyInventory) {
    await writeFile(resolve(dist, "index.html"), "<!doctype html><title>Runner</title>\n");
    await writeFile(resolve(dist, "sitemap.xml"), options.sitemap ?? sitemap());
  }
  return directory;
}

function configFor(directory: string, fallbackToHtmlScan = false): ResolvedConfig {
  const dist = resolve(directory, "dist");
  return {
    configPath: resolve(directory, "sdi.config.mjs"),
    siteId: "runner-test",
    siteUrl: "https://runner.example.test",
    source: { distDir: dist, sitemapPath: resolve(dist, "sitemap.xml"), fallbackToHtmlScan },
    normalization: { trailingSlash: "always" },
    statePath: resolve(directory, ".sdi/state.json"),
    reportPath: resolve(directory, ".sdi/last-run.json"),
  };
}

function sitemap(): string {
  return `<?xml version="1.0"?><urlset><url><loc>https://runner.example.test/</loc></url></urlset>`;
}

function emptySitemap(): string {
  return `<?xml version="1.0"?><urlset></urlset>`;
}

function stateWithThreeResources(config: ResolvedConfig): object {
  return {
    schemaVersion: 1,
    siteId: config.siteId,
    siteUrl: config.siteUrl,
    trailingSlash: config.normalization.trailingSlash,
    fingerprintProfile: "sha256-raw-html-v1",
    updatedAt: "2026-07-13T00:00:00.000Z",
    resources: {
      "https://runner.example.test/": { url: "https://runner.example.test/", hash: fingerprintHtml(Buffer.from("<!doctype html><title>Runner</title>\n")) },
      "https://runner.example.test/removed-a/": { url: "https://runner.example.test/removed-a/", hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      "https://runner.example.test/removed-b/": { url: "https://runner.example.test/removed-b/", hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    },
  };
}
