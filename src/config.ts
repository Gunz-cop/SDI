import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RedactedConfig } from "./report/types.js";

export interface ResolvedConfig {
  readonly configPath: string;
  readonly siteId: string;
  readonly siteUrl: string;
  readonly source: {
    readonly distDir: string;
    readonly sitemapPath: string;
    readonly fallbackToHtmlScan: boolean;
  };
  readonly normalization: {
    readonly trailingSlash: "preserve" | "always" | "never";
  };
  readonly statePath: string;
  readonly legacyStatePath?: string;
  readonly reportPath: string;
  readonly indexNow?: {
    readonly keyEnv: string;
    readonly key?: string;
    readonly keyLocation?: string;
  };
}

export class SdiConfigError extends Error {
  readonly code = "SDI_CONFIG_INVALID";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SdiConfigError";
  }
}

export interface LoadConfigOptions {
  readonly cwd?: string;
  readonly configPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly importModule?: (url: string) => Promise<unknown>;
}

const DEFAULT_STATE_PATH = ".sdi/state.json";
const DEFAULT_REPORT_PATH = ".sdi/last-run.json";
const DEFAULT_KEY_ENV = "INDEXNOW_KEY";
const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Loads SDI's single trusted MJS configuration module and resolves its effective paths. */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<ResolvedConfig> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = resolve(cwd, options.configPath ?? "sdi.config.mjs");
  const environment = options.environment ?? process.env;
  const importModule = options.importModule ?? defaultImportModule;

  if (extname(configPath) !== ".mjs") {
    throw invalidConfig(`SDI config must use the .mjs extension: ${configPath}`);
  }

  let moduleValue: unknown;

  try {
    moduleValue = await importModule(pathToFileURL(configPath).href);
  } catch (error: unknown) {
    throw invalidConfig(`Could not load SDI config: ${configPath}`, error);
  }

  const config = defaultExport(moduleValue, configPath);
  const configDir = resolve(configPath, "..");
  const topLevel = exactObject(config, "config", [
    "siteId", "siteUrl", "source", "normalization", "statePath", "legacyStatePath", "reportPath", "indexNow",
  ]);
  const siteId = requiredString(topLevel.siteId, "siteId");
  const siteUrl = resolveSiteUrl(environment.SDI_SITE_URL ?? topLevel.siteUrl);
  const source = exactObject(topLevel.source, "source", ["distDir", "sitemapPath", "fallbackToHtmlScan"]);
  const sourceDistDir = environment.SDI_DIST_DIR ?? source.distDir;
  const sourceSitemapPath = source.sitemapPath;
  const normalization = exactObject(topLevel.normalization, "normalization", ["trailingSlash"]);
  const trailingSlash = trailingSlashPolicy(normalization.trailingSlash);
  const statePath = resolvePath(environment.SDI_STATE_PATH ?? topLevel.statePath ?? DEFAULT_STATE_PATH, configDir, "statePath");
  const reportPath = resolvePath(topLevel.reportPath ?? DEFAULT_REPORT_PATH, configDir, "reportPath");
  const legacyStatePath = optionalPath(topLevel.legacyStatePath, configDir, "legacyStatePath");

  return {
    configPath,
    siteId,
    siteUrl,
    source: {
      distDir: resolvePath(sourceDistDir, configDir, "source.distDir"),
      sitemapPath: resolvePath(sourceSitemapPath, configDir, "source.sitemapPath"),
      fallbackToHtmlScan: optionalBoolean(source.fallbackToHtmlScan, true, "source.fallbackToHtmlScan"),
    },
    normalization: { trailingSlash },
    statePath,
    ...(legacyStatePath === undefined ? {} : { legacyStatePath }),
    reportPath,
    ...(topLevel.indexNow === undefined ? {} : { indexNow: resolveIndexNow(topLevel.indexNow, siteUrl, environment) }),
  };
}

/** Rebuilds the report-safe configuration without carrying the resolved IndexNow key. */
export function toRedactedConfig(config: ResolvedConfig): RedactedConfig {
  const result: RedactedConfig = {
    siteId: config.siteId,
    siteUrl: config.siteUrl,
    source: {
      distDir: config.source.distDir,
      sitemapPath: config.source.sitemapPath,
      fallbackToHtmlScan: config.source.fallbackToHtmlScan,
    },
    normalization: { trailingSlash: config.normalization.trailingSlash },
    statePath: config.statePath,
    reportPath: config.reportPath,
  };

  if (config.legacyStatePath !== undefined) {
    result.legacyStatePath = config.legacyStatePath;
  }

  if (config.indexNow !== undefined) {
    const indexNow: NonNullable<RedactedConfig["indexNow"]> = { keyEnv: config.indexNow.keyEnv };

    if (config.indexNow.key !== undefined && config.indexNow.keyLocation !== undefined && !keyLocationContains(config.indexNow.keyLocation, config.indexNow.key)) {
      indexNow.keyLocation = config.indexNow.keyLocation;
    }

    result.indexNow = indexNow;
  }

  return result;
}

function defaultImportModule(url: string): Promise<unknown> {
  return import(url);
}

function defaultExport(value: unknown, configPath: string): Record<string, unknown> {
  if (!isPlainObject(value) || !("default" in value) || !isPlainObject(value.default)) {
    throw invalidConfig(`SDI config must have a plain-object default export: ${configPath}`);
  }

  return value.default;
}

function resolveIndexNow(value: unknown, siteUrl: string, environment: NodeJS.ProcessEnv): ResolvedConfig["indexNow"] {
  const indexNow = exactObject(value, "indexNow", ["keyEnv", "keyLocation"]);
  const keyEnv = optionalString(indexNow.keyEnv, DEFAULT_KEY_ENV, "indexNow.keyEnv");

  if (!ENVIRONMENT_VARIABLE_NAME.test(keyEnv)) {
    throw invalidConfig("indexNow.keyEnv must be a valid environment variable name");
  }

  const keyLocation = optionalHttpUrl(indexNow.keyLocation, "indexNow.keyLocation", siteUrl);
  const key = nonEmptyEnvironmentValue(environment[keyEnv]);
  return { keyEnv, ...(key === undefined ? {} : { key }), ...(keyLocation === undefined ? {} : { keyLocation }) };
}

function exactObject(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw invalidConfig(`${label} must be a plain object with known keys only`);
  }

  return value;
}

function resolveSiteUrl(value: unknown): string {
  const siteUrl = requiredString(value, "siteUrl");
  let url: URL;

  try {
    url = new URL(siteUrl);
  } catch (error: unknown) {
    throw invalidConfig("siteUrl must be an absolute HTTP(S) URL", error);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalidConfig("siteUrl must use HTTP(S)");
  }

  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname !== "/") {
    throw invalidConfig("siteUrl must contain only an HTTP(S) origin");
  }

  return url.origin;
}

function resolvePath(value: unknown, configDir: string, label: string): string {
  return resolve(configDir, requiredString(value, label));
}

function optionalPath(value: unknown, configDir: string, label: string): string | undefined {
  return value === undefined ? undefined : resolvePath(value, configDir, label);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidConfig(`${label} must be a non-empty string`);
  }

  return value;
}

function optionalString(value: unknown, fallback: string, label: string): string {
  return value === undefined ? fallback : requiredString(value, label);
}

function optionalBoolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "boolean") {
    throw invalidConfig(`${label} must be a boolean`);
  }

  return value;
}

function trailingSlashPolicy(value: unknown): ResolvedConfig["normalization"]["trailingSlash"] {
  if (value === "preserve" || value === "always" || value === "never") {
    return value;
  }

  throw invalidConfig("normalization.trailingSlash must be preserve, always, or never");
}

function optionalHttpUrl(value: unknown, label: string, siteUrl: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const text = requiredString(value, label);
  let url: URL;

  try {
    url = new URL(text);
  } catch (error: unknown) {
    throw invalidConfig(`${label} must be an absolute HTTP(S) URL`, error);
  }

  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== siteUrl) {
    throw invalidConfig(`${label} must be HTTP(S) and same-origin with siteUrl`);
  }

  return url.href;
}

function nonEmptyEnvironmentValue(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

function keyLocationContains(keyLocation: string, key: string): boolean {
  if (keyLocation.includes(key)) {
    return true;
  }

  try {
    return decodeURIComponent(keyLocation).includes(key);
  } catch {
    return true;
  }
}

function invalidConfig(message: string, cause?: unknown): SdiConfigError {
  return new SdiConfigError(message, cause === undefined ? undefined : { cause });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
