import { readFile } from "node:fs/promises";
import { FINGERPRINT_PROFILE } from "../core/fingerprint.js";
import { normalizeUrl, UrlNormalizationError } from "../core/normalize.js";
import type { DiscoveryState, TrailingSlashPolicy, UrlRecord } from "../core/types.js";

export interface FileStateStoreOptions {
  statePath: string;
  legacyStatePath?: string;
  siteId: string;
  siteUrl: string;
  trailingSlash: TrailingSlashPolicy;
  now?: () => Date;
}

export type FileStateErrorCode = "state-corrupt" | "state-incompatible" | "legacy-invalid" | "legacy-collision";

export class FileStateError extends Error {
  constructor(
    public readonly code: FileStateErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "FileStateError";
  }
}

/**
 * Loads SDI's versioned state or imports the legacy snapshot into memory.
 * save() is deliberately introduced in Stage 3.4, so this class does not yet implement StateStore.
 */
export class FileStateStore {
  private readonly now: () => Date;

  constructor(private readonly options: FileStateStoreOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async load(): Promise<DiscoveryState | null> {
    try {
      return await this.loadStateFile(this.options.statePath);
    } catch (error: unknown) {
      if (isMissingFile(error)) {
        return this.loadLegacyWhenAvailable();
      }

      if (isCorruptState(error)) {
        return this.loadBackupOrAbort(error);
      }

      throw error;
    }
  }

  private async loadBackupOrAbort(primaryError: FileStateError): Promise<DiscoveryState> {
    try {
      return await this.loadStateFile(`${this.options.statePath}.bak`);
    } catch (backupError: unknown) {
      if (backupError instanceof FileStateError && backupError.code === "state-incompatible") {
        throw backupError;
      }

      throw new FileStateError(
        "state-corrupt",
        `State and backup are unusable: ${this.options.statePath}`,
        { cause: { primaryError, backupError } },
      );
    }
  }

  private async loadLegacyWhenAvailable(): Promise<DiscoveryState | null> {
    if (this.options.legacyStatePath === undefined) {
      return null;
    }

    let raw: string;

    try {
      raw = await readFile(this.options.legacyStatePath, "utf8");
    } catch (error: unknown) {
      if (isMissingFile(error)) {
        return null;
      }

      throw error;
    }

    return importLegacyState(parseJson(raw, this.options.legacyStatePath, "legacy-invalid"), this.options, this.now());
  }

  private async loadStateFile(path: string): Promise<DiscoveryState> {
    const raw = await readFile(path, "utf8");
    const state = parseDiscoveryState(parseJson(raw, path, "state-corrupt"), path);

    assertStateCompatibility(state, this.options);
    return state;
  }
}

function parseJson(raw: string, path: string, code: FileStateErrorCode): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    throw new FileStateError(code, `Invalid JSON in ${path}.`, { cause: error });
  }
}

function parseDiscoveryState(value: unknown, path: string): DiscoveryState {
  if (!isRecord(value)) {
    throw new FileStateError("state-corrupt", `State must be an object: ${path}`);
  }

  if (value.schemaVersion !== 1) {
    throw new FileStateError("state-corrupt", `Unsupported state schema in ${path}.`);
  }

  if (!isNonEmptyString(value.siteId) || !isHttpUrl(value.siteUrl) || !isTrailingSlashPolicy(value.trailingSlash)) {
    throw new FileStateError("state-corrupt", `State metadata is invalid: ${path}`);
  }

  if (value.fingerprintProfile !== FINGERPRINT_PROFILE || !isIsoTimestamp(value.updatedAt) || !isRecord(value.resources)) {
    throw new FileStateError("state-corrupt", `State fields are invalid: ${path}`);
  }

  const resources: Record<string, UrlRecord> = {};

  for (const [key, rawRecord] of Object.entries(value.resources)) {
    const record = parseUrlRecord(rawRecord, value.siteUrl, value.trailingSlash, "state-corrupt", path);

    if (key !== record.url) {
      throw new FileStateError("state-corrupt", `State resource key must equal its URL: ${path}`);
    }

    resources[key] = record;
  }

  return {
    schemaVersion: 1,
    siteId: value.siteId,
    siteUrl: value.siteUrl,
    trailingSlash: value.trailingSlash,
    fingerprintProfile: FINGERPRINT_PROFILE,
    updatedAt: value.updatedAt,
    resources,
  };
}

function importLegacyState(value: unknown, options: FileStateStoreOptions, now: Date): DiscoveryState {
  if (!isRecord(value)) {
    throw new FileStateError("legacy-invalid", "Legacy state must be a URL map.");
  }

  const resources: Record<string, UrlRecord> = {};

  for (const [key, rawRecord] of Object.entries(value)) {
    const record = parseLegacyRecord(rawRecord, options, key);
    const normalizedKey = normalizeLegacyUrl(key, options, "Legacy state key is invalid.");
    const normalizedEntryUrl = normalizeLegacyUrl(record.url, options, "Legacy state entry URL is invalid.");

    if (normalizedKey !== normalizedEntryUrl) {
      throw new FileStateError("legacy-invalid", `Legacy key and entry URL disagree: ${key}`);
    }

    if (resources[normalizedKey] !== undefined) {
      throw new FileStateError("legacy-collision", `Legacy URLs collide after normalization: ${normalizedKey}`);
    }

    resources[normalizedKey] = {
      url: normalizedKey,
      hash: record.hash,
      ...(record.lastmod === undefined ? {} : { lastmod: record.lastmod }),
    };
  }

  return {
    schemaVersion: 1,
    siteId: options.siteId,
    siteUrl: options.siteUrl,
    trailingSlash: options.trailingSlash,
    fingerprintProfile: FINGERPRINT_PROFILE,
    updatedAt: now.toISOString(),
    resources,
  };
}

function parseLegacyRecord(value: unknown, options: FileStateStoreOptions, key: string): UrlRecord {
  if (!isRecord(value) || !isNonEmptyString(value.url) || !isHash(value.hash)) {
    throw new FileStateError("legacy-invalid", `Legacy resource is invalid: ${key}`);
  }

  if (value.lastmod !== undefined && !isNonEmptyString(value.lastmod)) {
    throw new FileStateError("legacy-invalid", `Legacy lastmod is invalid: ${key}`);
  }

  try {
    normalizeUrl(value.url, { siteUrl: options.siteUrl, trailingSlash: options.trailingSlash });
  } catch (error: unknown) {
    throw new FileStateError("legacy-invalid", `Legacy URL is invalid: ${key}`, { cause: error });
  }

  return {
    url: value.url,
    hash: value.hash,
    ...(value.lastmod === undefined ? {} : { lastmod: value.lastmod }),
  };
}

function parseUrlRecord(
  value: unknown,
  siteUrl: string,
  trailingSlash: TrailingSlashPolicy,
  code: FileStateErrorCode,
  path: string,
): UrlRecord {
  if (!isRecord(value) || !isNonEmptyString(value.url) || !isHash(value.hash)) {
    throw new FileStateError(code, `Invalid state resource in ${path}.`);
  }

  if (value.lastmod !== undefined && !isNonEmptyString(value.lastmod)) {
    throw new FileStateError(code, `Invalid state lastmod in ${path}.`);
  }

  let normalizedUrl: string;

  try {
    normalizedUrl = normalizeUrl(value.url, { siteUrl, trailingSlash });
  } catch (error: unknown) {
    throw new FileStateError(code, `Invalid state URL in ${path}.`, { cause: error });
  }

  if (normalizedUrl !== value.url) {
    throw new FileStateError(code, `State URL is not normalized in ${path}.`);
  }

  return {
    url: value.url,
    hash: value.hash,
    ...(value.lastmod === undefined ? {} : { lastmod: value.lastmod }),
  };
}

function assertStateCompatibility(state: DiscoveryState, options: FileStateStoreOptions): void {
  if (state.siteId !== options.siteId) {
    throw new FileStateError("state-incompatible", "State siteId does not match the configured site.");
  }

  if (originFor(state.siteUrl) !== originFor(options.siteUrl)) {
    throw new FileStateError("state-incompatible", "State origin does not match the configured site.");
  }

  if (state.trailingSlash !== options.trailingSlash) {
    throw new FileStateError("state-incompatible", "State trailingSlash does not match the configured site.");
  }
}

function normalizeLegacyUrl(value: string, options: FileStateStoreOptions, message: string): string {
  try {
    return normalizeUrl(value, { siteUrl: options.siteUrl, trailingSlash: options.trailingSlash });
  } catch (error: unknown) {
    if (error instanceof UrlNormalizationError) {
      throw new FileStateError("legacy-invalid", message, { cause: error });
    }

    throw error;
  }
}

function originFor(value: string): string {
  return new URL(value).origin;
}

function isHttpUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isTrailingSlashPolicy(value: unknown): value is TrailingSlashPolicy {
  return value === "preserve" || value === "always" || value === "never";
}

function isIsoTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isCorruptState(error: unknown): error is FileStateError {
  return error instanceof FileStateError && error.code === "state-corrupt";
}
