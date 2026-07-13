import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../../src/config.js";
import { fingerprintHtml } from "../../src/core/fingerprint.js";
import { runDryRun } from "../../src/run.js";

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
