import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveRuntimeConfig } from "./config.js";
import { runDiscovery } from "./core/engine.js";
import { getStaticSiteUrls } from "./discovery/staticSiteSource.js";
import { FileStateStore } from "./state/fileStateStore.js";
import { loadEnvFile } from "./utils/env.js";

export interface RunCliOptions {
  cwd?: string;
  flags?: Record<string, string | boolean>;
}

export async function runSbi(options: RunCliOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  await loadEnvFile(path.join(cwd, ".env"));

  const config = await resolveRuntimeConfig(cwd, options.flags ?? {});
  console.log("SBI: Starting canonical execution...");

  const currentUrls = await getStaticSiteUrls({
    distDir: config.distDir,
    siteUrl: config.siteUrl,
    sitemapPath: config.sitemapPath,
  });

  console.log(`SBI: Found ${currentUrls.length} URLs in source output.`);
  if (currentUrls.length === 0) {
    console.log("SBI: No URLs detected, skipping submission.");
    return 0;
  }

  const stateStore = new FileStateStore(config.statePath);
  const previousUrls = await loadManifest(config.manifestPath);
  const summary = await runDiscovery(currentUrls, previousUrls, stateStore, config.destinations, {
    logPath: config.logPath,
    dryRun: config.dryRun,
    forceSubmit: config.forceSubmit,
    optionalDestinations: config.optionalDestinations,
  });

  console.log(
    `SBI: Detected ${summary.changed.length} new/modified and ${summary.deleted.length} deleted URLs.`,
  );

  if (!config.dryRun) {
    await fs.mkdir(path.dirname(config.manifestPath), { recursive: true });
    await fs.writeFile(config.manifestPath, JSON.stringify(summary.manifestUrls, null, 2), "utf-8");
  }

  if (summary.dryRun) {
    console.log("SBI: Dry-run mode enabled. No state or manifest files were changed.");
  }

  if (config.destinations.length === 0) {
    console.log("SBI: No destinations configured. Change tracking completed without submissions.");
  } else {
    console.log(`SBI: Destinations active -> ${config.destinations.map((destination) => destination.name).join(", ")}`);
  }

  for (const entry of summary.logEntries) {
    const resultSummary = Object.entries(entry.results)
      .map(([name, result]) => `${name}:${result.success ? "ok" : "fail"}`)
      .join(", ");
    console.log(`SBI: ${entry.url} -> ${resultSummary || "tracked-only"}`);
  }

  console.log("SBI: Canonical execution completed.");
  return 0;
}

async function loadManifest(filePath: string): Promise<string[]> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
