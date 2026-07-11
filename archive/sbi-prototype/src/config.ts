import * as path from "node:path";
import type { DestinationAdapter } from "./core/types.js";
import { GoogleIndexingDestination, loadGoogleCredentials } from "./destinations/googleIndexingDestination.js";
import { IndexNowDestination } from "./destinations/indexNowDestination.js";

export type DestinationMode = "off" | "optional" | "required";

export interface RuntimeConfig {
  cwd: string;
  siteUrl: string;
  distDir: string;
  sitemapPath: string;
  statePath: string;
  manifestPath: string;
  logPath: string;
  dryRun: boolean;
  forceSubmit: boolean;
  optionalDestinations: string[];
  destinations: DestinationAdapter[];
}

export async function resolveRuntimeConfig(
  cwd: string,
  flags: Record<string, string | boolean>,
): Promise<RuntimeConfig> {
  const siteUrl = readString(flags, "site-url") ?? env("SBI_SITE_URL", "SDI_SITE_URL");
  if (!siteUrl) {
    throw new Error("Missing site URL. Provide --site-url or SBI_SITE_URL.");
  }

  const distDir = path.resolve(cwd, readString(flags, "dist-dir") ?? env("SBI_DIST_DIR", "SDI_DIST_DIR") ?? "dist");
  const sitemapPath = path.resolve(
    cwd,
    readString(flags, "sitemap-path") ?? env("SBI_SITEMAP_PATH") ?? path.join(distDir, "sitemap-0.xml"),
  );
  const statePath = path.resolve(
    cwd,
    readString(flags, "state-path") ?? env("SBI_STATE_PATH", "SDI_STATE_PATH") ?? ".sbi/state.json",
  );
  const manifestPath = path.resolve(
    cwd,
    readString(flags, "manifest-path") ?? env("SBI_MANIFEST_PATH", "SDI_MANIFEST_PATH") ?? ".sbi/manifest.json",
  );
  const logPath = path.resolve(
    cwd,
    readString(flags, "log-path") ?? env("SBI_LOG_PATH", "SDI_LOG_PATH") ?? ".sbi/submissions.json",
  );

  const dryRun = readBoolean(flags, "dry-run") ?? envBoolean("SBI_DRY_RUN") ?? false;
  const forceSubmit = readBoolean(flags, "force-submit") ?? envBoolean("SBI_FORCE_SUBMIT", "SDI_FORCE_SUBMIT") ?? false;

  const googleMode = readMode(flags, "google") ?? envMode("SBI_GOOGLE_MODE") ?? "optional";
  const indexNowMode = readMode(flags, "indexnow") ?? envMode("SBI_INDEXNOW_MODE") ?? "required";

  const destinations: DestinationAdapter[] = [];
  const optionalDestinations = new Set<string>((env("SBI_OPTIONAL_DESTINATIONS") ?? "google").split(",").map((value) => value.trim()).filter(Boolean));

  const siteHost = new URL(siteUrl).host;
  const indexNowKey = env("INDEXNOW_KEY");
  if (indexNowMode !== "off" && indexNowKey) {
    destinations.push(
      new IndexNowDestination({
        host: env("INDEXNOW_HOST") ?? siteHost,
        key: indexNowKey,
        keyLocation: env("INDEXNOW_KEY_LOCATION") ?? undefined,
      }),
    );
    if (indexNowMode === "optional") {
      optionalDestinations.add("indexnow");
    } else {
      optionalDestinations.delete("indexnow");
    }
  }

  const googleCredentials = googleMode === "off"
    ? null
    : await loadGoogleCredentials({
        clientEmail: env("GOOGLE_CLIENT_EMAIL") ?? undefined,
        privateKey: env("GOOGLE_PRIVATE_KEY") ?? undefined,
        serviceAccountJson: env("INDEXING_SERVICE_ACCOUNT_JSON") ?? undefined,
        serviceAccountFile: path.resolve(cwd, env("GOOGLE_SERVICE_ACCOUNT_FILE") ?? "service-account.json"),
      });

  if (googleMode !== "off" && googleCredentials) {
    destinations.push(new GoogleIndexingDestination(googleCredentials));
    if (googleMode === "optional") {
      optionalDestinations.add("google");
    } else {
      optionalDestinations.delete("google");
    }
  }

  return {
    cwd,
    siteUrl,
    distDir,
    sitemapPath,
    statePath,
    manifestPath,
    logPath,
    dryRun,
    forceSubmit,
    optionalDestinations: [...optionalDestinations],
    destinations,
  };
}

function env(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value) {
      return value;
    }
  }
  return undefined;
}

function envBoolean(...names: string[]): boolean | undefined {
  const value = env(...names);
  if (value === undefined) {
    return undefined;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function envMode(name: string): DestinationMode | undefined {
  const value = process.env[name]?.toLowerCase();
  if (value === "off" || value === "optional" || value === "required") {
    return value;
  }
  return undefined;
}

function readString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

function readBoolean(flags: Record<string, string | boolean>, key: string): boolean | undefined {
  const value = flags[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  }
  return undefined;
}

function readMode(flags: Record<string, string | boolean>, key: string): DestinationMode | undefined {
  const value = readString(flags, key)?.toLowerCase();
  if (value === "off" || value === "optional" || value === "required") {
    return value;
  }
  return undefined;
}
