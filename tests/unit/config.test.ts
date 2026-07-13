import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig, SdiConfigError, toRedactedConfig } from "../../src/config.js";

const cwd = resolve("workspace");
const configPath = resolve(cwd, "config/sdi.config.mjs");

describe("SDI config", () => {
  it("loads the default MJS file through a file URL", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "sdi-config-"));

    try {
      await writeFile(resolve(directory, "sdi.config.mjs"), `export default ${JSON.stringify(validConfig())};\n`);
      const config = await loadConfig({ cwd: directory, environment: {} });

      expect(config.configPath).toBe(resolve(directory, "sdi.config.mjs"));
      expect(config.source.fallbackToHtmlScan).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resolves documented defaults, paths, and the permitted legacy overrides", async () => {
    const importedUrls: string[] = [];
    const config = await loadConfig({
      cwd,
      configPath: "config/sdi.config.mjs",
      environment: { SDI_SITE_URL: "https://override.example", SDI_DIST_DIR: "legacy-dist", SDI_STATE_PATH: "legacy/state.json", CUSTOM_KEY: "secret" },
      importModule: async (url) => {
        importedUrls.push(url);
        return { default: validConfig({ indexNow: { keyEnv: "CUSTOM_KEY", keyLocation: "https://override.example/key.txt" } }) };
      },
    });

    expect(importedUrls).toEqual([pathToFileURL(configPath).href]);
    expect(config).toEqual({
      configPath,
      siteId: "site",
      siteUrl: "https://override.example",
      source: { distDir: resolve(cwd, "config/legacy-dist"), sitemapPath: resolve(cwd, "config/dist/sitemap.xml"), fallbackToHtmlScan: true },
      normalization: { trailingSlash: "always" },
      statePath: resolve(cwd, "config/legacy/state.json"),
      reportPath: resolve(cwd, "config/.sdi/last-run.json"),
      indexNow: { keyEnv: "CUSTOM_KEY", key: "secret", keyLocation: "https://override.example/key.txt" },
    });
  });

  it.each([
    ["unknown top-level key", { extra: true }],
    ["literal key", { indexNow: { key: "secret" } }],
    ["missing sitemap", { source: { distDir: "dist" } }],
    ["missing slash policy", { normalization: {} }],
    ["invalid site path", { siteUrl: "https://example.com/blog" }],
    ["invalid key environment name", { indexNow: { keyEnv: "NOT-VALID" } }],
    ["foreign key location", { indexNow: { keyLocation: "https://other.example/key.txt" } }],
  ])("rejects %s", async (_name, change) => {
    await expect(loadConfig({ cwd, configPath, importModule: async () => ({ default: validConfig(change) }) })).rejects.toMatchObject({
      code: "SDI_CONFIG_INVALID",
    } satisfies Partial<SdiConfigError>);
  });

  it("wraps missing and failed imports without exposing environment values", async () => {
    await expect(loadConfig({ cwd, configPath, environment: { INDEXNOW_KEY: "do-not-print" }, importModule: async () => { throw new Error("import broke"); } }))
      .rejects.toMatchObject({ code: "SDI_CONFIG_INVALID", message: expect.not.stringContaining("do-not-print") });
  });

  it("redacts the key and omits unsafe or unresolved key locations", async () => {
    const safe = await loadConfig({ cwd, configPath, environment: { INDEXNOW_KEY: "secret" }, importModule: async () => ({ default: validConfig({ indexNow: { keyLocation: "https://example.com/key.txt" } }) }) });
    const unsafe = await loadConfig({ cwd, configPath, environment: { INDEXNOW_KEY: "secret" }, importModule: async () => ({ default: validConfig({ indexNow: { keyLocation: "https://example.com/secret.txt" } }) }) });
    const encoded = await loadConfig({ cwd, configPath, environment: { INDEXNOW_KEY: "secret" }, importModule: async () => ({ default: validConfig({ indexNow: { keyLocation: "https://example.com/%73ecret.txt" } }) }) });
    const unresolved = await loadConfig({ cwd, configPath, environment: {}, importModule: async () => ({ default: validConfig({ indexNow: { keyLocation: "https://example.com/key.txt" } }) }) });

    expect(toRedactedConfig(safe)).toMatchObject({ indexNow: { keyEnv: "INDEXNOW_KEY", keyLocation: "https://example.com/key.txt" } });
    expect(toRedactedConfig(unsafe)).toEqual(expect.objectContaining({ indexNow: { keyEnv: "INDEXNOW_KEY" } }));
    expect(toRedactedConfig(encoded)).toEqual(expect.objectContaining({ indexNow: { keyEnv: "INDEXNOW_KEY" } }));
    expect(toRedactedConfig(unresolved)).toEqual(expect.objectContaining({ indexNow: { keyEnv: "INDEXNOW_KEY" } }));
    expect(JSON.stringify(toRedactedConfig(safe))).not.toContain("secret");
  });
});

function validConfig(change: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    siteId: "site",
    siteUrl: "https://example.com/",
    source: { distDir: "dist", sitemapPath: "dist/sitemap.xml" },
    normalization: { trailingSlash: "always" },
    ...change,
  };
}
