import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeCli, HELP_TEXT, VERSION } from "../src/cli.js";
import { SdiConfigError, type ResolvedConfig } from "../src/config.js";
import type { RunOutcome } from "../src/run.js";

const config: ResolvedConfig = {
  configPath: "/workspace/sdi.config.mjs",
  siteId: "site",
  siteUrl: "https://example.com",
  source: { distDir: "/workspace/dist", sitemapPath: "/workspace/dist/sitemap.xml", fallbackToHtmlScan: true },
  normalization: { trailingSlash: "always" },
  statePath: "/workspace/.sdi/state.json",
  reportPath: "/workspace/.sdi/last-run.json",
  indexNow: { keyEnv: "INDEXNOW_KEY", key: "secret" },
};

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SDI CLI", () => {
  it("shows help and version without loading .env or configuration", async () => {
    const loadEnvFile = vi.fn();
    const loadConfig = vi.fn(async () => config);

    await expect(executeCli([], { loadEnvFile, loadConfig })).resolves.toEqual({ exitCode: 0, stdout: HELP_TEXT, stderr: "" });
    await expect(executeCli(["--version"])).resolves.toEqual({ exitCode: 0, stdout: `${VERSION}\n`, stderr: "" });
    expect(loadEnvFile).not.toHaveBeenCalled();
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it("loads .env then config and dispatches dry-run without touching live flags", async () => {
    const loadEnvFile = vi.fn();
    const loadConfig = vi.fn(async () => config);
    const runDryRun = vi.fn(async () => success("dry-run"));

    const result = await executeCli(["run", "--dry-run", "--config", "project/sdi.config.mjs", "--clear-stale-lock"], {
      cwd: "/workspace",
      environment: { INDEXNOW_KEY: "secret" },
      loadEnvFile,
      loadConfig,
      runDryRun,
    });

    expect(loadEnvFile).toHaveBeenCalledWith(expect.stringMatching(/[\\/]workspace[\\/]\.env$/));
    expect(loadConfig).toHaveBeenCalledWith({ cwd: "/workspace", configPath: "project/sdi.config.mjs", environment: { INDEXNOW_KEY: "secret" } });
    expect(runDryRun).toHaveBeenCalledWith({ config, mode: "dry-run", clearStaleLock: true });
    expect(result).toMatchObject({ exitCode: 0, stdout: "SDI dry-run: success\nChanges: created=0 updated=0 unchanged=1 deleted=0\n", stderr: "" });
  });

  it("dispatches confirmed baseline and live flags to their isolated runner modes", async () => {
    const runBaseline = vi.fn(async () => success("baseline"));
    const runLive = vi.fn(async () => success("live"));
    const dependencies = { cwd: "/workspace", environment: {}, loadEnvFile: vi.fn(), loadConfig: async () => config, runBaseline, runLive };

    await executeCli(["baseline", "--confirm", "--clear-stale-lock"], dependencies);
    await executeCli(["run", "--force", "--allow-large-delete", "--clear-stale-lock"], dependencies);

    expect(runBaseline).toHaveBeenCalledWith({ config, mode: "baseline", confirmed: true, clearStaleLock: true });
    expect(runLive).toHaveBeenCalledWith({ config, mode: "live", force: true, allowLargeDelete: true, clearStaleLock: true });
  });

  it.each([
    ["unknown command", ["unknown"]],
    ["unknown flag", ["run", "--key", "secret"]],
    ["repeated flag", ["run", "--dry-run", "--dry-run"]],
    ["missing config value", ["run", "--config"]],
    ["dry-run force", ["run", "--dry-run", "--force"]],
    ["baseline without confirmation", ["baseline"]],
    ["baseline run flag", ["baseline", "--confirm", "--force"]],
  ])("rejects %s before loading configuration", async (_name, args) => {
    const loadConfig = vi.fn(async () => config);

    const result = await executeCli(args, { loadConfig, loadEnvFile: vi.fn() });

    expect(result).toMatchObject({ exitCode: 2, stdout: "", stderr: expect.stringContaining("SDI_USAGE_INVALID") });
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it("treats an unreadable local .env and invalid config as usage errors without a report", async () => {
    const envFailure = Object.assign(new Error("unreadable"), { code: "EACCES" });
    const result = await executeCli(["run"], { loadEnvFile: () => { throw envFailure; }, loadConfig: async () => config });

    expect(result).toEqual({ exitCode: 2, stdout: "", stderr: "SDI_CONFIG_INVALID: Local .env could not be loaded.\n" });

    const invalid = await executeCli(["run"], {
      loadEnvFile: () => undefined,
      loadConfig: async () => { throw new SdiConfigError("invalid"); },
    });
    expect(invalid).toEqual({ exitCode: 2, stdout: "", stderr: "SDI_CONFIG_INVALID: Configuration could not be loaded.\n" });
  });

  it("ignores an absent .env and continues to configuration", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const loadConfig = vi.fn(async () => config);

    const result = await executeCli(["run", "--dry-run"], { loadEnvFile: () => { throw missing; }, loadConfig, runDryRun: async () => success("dry-run") });

    expect(result.exitCode).toBe(0);
    expect(loadConfig).toHaveBeenCalledOnce();
  });

  it("loads a real .env before configuration without overwriting existing environment", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "sdi-cli-env-"));
    directories.push(directory);
    const loadedName = "SDI_CLI_ENV_TEST";
    const existingName = "SDI_CLI_EXISTING_TEST";
    const previousLoaded = process.env[loadedName];
    const previousExisting = process.env[existingName];
    await writeFile(resolve(directory, ".env"), `${loadedName}=from-file\n${existingName}=from-file\n`);
    process.env[existingName] = "already-present";

    try {
      const loadConfig = vi.fn(async () => config);
      await executeCli(["run", "--dry-run"], { cwd: directory, loadConfig, runDryRun: async () => success("dry-run") });

      expect(loadConfig).toHaveBeenCalledWith(expect.objectContaining({ environment: expect.objectContaining({ [loadedName]: "from-file", [existingName]: "already-present" }) }));
    } finally {
      restoreEnvironment(loadedName, previousLoaded);
      restoreEnvironment(existingName, previousExisting);
    }
  });

  it("presents functional report errors and terminal diagnostics without exposing configuration secrets", async () => {
    const result = await executeCli(["run"], {
      loadEnvFile: () => undefined,
      loadConfig: async () => ({
        ...config,
        indexNow: {
          ...config.indexNow,
          keyLocation: "https://example.com/%73ecret.txt",
        },
      }),
      runLive: async () => ({
        kind: "operational-failure",
        exitCode: 1,
        reportWritten: true,
        report: report("live", "failed", [{ code: "INDEXNOW_HTTP_400", message: "IndexNow rejected a publish batch." }]),
        terminalDiagnostics: [{ code: "SDI_LOCK_RELEASE_FAILED", message: "The execution lock could not be released." }],
      }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("ERROR INDEXNOW_HTTP_400");
    expect(result.stderr).toBe("ERROR SDI_LOCK_RELEASE_FAILED: The execution lock could not be released.\n");
    expect(`${result.stdout}${result.stderr}`).not.toContain("secret");
    expect(`${result.stdout}${result.stderr}`).not.toContain("%73ecret");
  });

  it.each([
    ["repeated config", ["run", "--config", "a.mjs", "--config", "b.mjs"]],
    ["flag-shaped config", ["run", "--config", "--dry-run"]],
    ["confirm on run", ["run", "--confirm"]],
    ["large delete with dry-run", ["run", "--dry-run", "--allow-large-delete"]],
  ])("rejects %s before runner dispatch", async (_name, args) => {
    const result = await executeCli(args, { loadEnvFile: vi.fn(), loadConfig: async () => config });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("SDI_USAGE_INVALID");
  });

  it("preserves runner exit codes and prints no-report failures only to stderr", async () => {
    const noReportFailure: RunOutcome = {
      kind: "operational-failure",
      exitCode: 1,
      reportWritten: false,
      terminalDiagnostics: [{ code: "SDI_LOCKED", message: "Another SDI execution already owns the state lock." }],
    };
    const failure = await executeCli(["run"], { loadEnvFile: vi.fn(), loadConfig: async () => config, runLive: async () => noReportFailure });
    const successResult = await executeCli(["run", "--dry-run"], { loadEnvFile: vi.fn(), loadConfig: async () => config, runDryRun: async () => success("dry-run") });
    const usage = await executeCli(["baseline"], { loadEnvFile: vi.fn(), loadConfig: async () => config });

    expect(successResult.exitCode).toBe(0);
    expect(failure).toEqual({ exitCode: 1, stdout: "", stderr: "ERROR SDI_LOCKED: Another SDI execution already owns the state lock.\n" });
    expect(usage.exitCode).toBe(2);
  });

  it("propagates unexpected config and runner failures to the entrypoint", async () => {
    await expect(executeCli(["run"], { loadEnvFile: vi.fn(), loadConfig: async () => { throw new Error("unexpected config"); } })).rejects.toThrow("unexpected config");
    await expect(executeCli(["run"], { loadEnvFile: vi.fn(), loadConfig: async () => config, runLive: async () => { throw new Error("unexpected runner"); } })).rejects.toThrow("unexpected runner");
  });

  it("runs the compiled help entrypoint with stdout, exit code, and no process.exit call", async () => {
    const child = spawnSync(process.execPath, [resolve("dist/cli.js"), "--help"], { encoding: "utf8" });

    expect(child.status).toBe(0);
    expect(child.stdout).toBe(HELP_TEXT);
    expect(child.stderr).toBe("");
    await expect(readFile(resolve("src/cli.ts"), "utf8")).resolves.not.toContain("process.exit(");
  });
});

function success(mode: "live" | "dry-run" | "baseline"): RunOutcome {
  return { kind: "success", exitCode: 0, reportWritten: true, report: report(mode, "success"), terminalDiagnostics: [] };
}

function report(
  mode: "live" | "dry-run" | "baseline",
  status: "success" | "failed",
  errors: Array<{ code: string; message: string }> = [],
) {
  return {
    schemaVersion: 1 as const,
    runId: "run-1",
    sdiVersion: VERSION,
    siteId: "site",
    mode,
    status,
    startedAt: "2026-07-13T00:00:00.000Z",
    finishedAt: "2026-07-13T00:00:01.000Z",
    durationMs: 1_000,
    source: { sitemapUsed: true, discovered: 1, rejected: 0, duplicates: 0 },
    changes: { created: 0, updated: 0, unchanged: 1, deleted: 0 },
    changeUrls: { created: [], updated: [], deleted: [] },
    warnings: [],
    errors,
    config: {
      siteId: "site",
      siteUrl: "https://example.com",
      source: { distDir: "/workspace/dist", sitemapPath: "/workspace/dist/sitemap.xml", fallbackToHtmlScan: true },
      normalization: { trailingSlash: "always" as const },
      statePath: "/workspace/.sdi/state.json",
      reportPath: "/workspace/.sdi/last-run.json",
    },
  };
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
