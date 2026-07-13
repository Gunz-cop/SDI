import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { fingerprintHtml } from "../core/fingerprint.js";
import { normalizeUrl, UrlNormalizationError } from "../core/normalize.js";
import type { DiscoveredResource, Source, TrailingSlashPolicy, UrlRecord } from "../core/types.js";

export interface AstroBuildSourceOptions {
  siteUrl: string;
  distDir: string;
  sitemapPath: string;
  fallbackToHtmlScan: boolean;
}

export interface ComposeDiscoveredResourcesOptions {
  siteUrl: string;
  trailingSlash: TrailingSlashPolicy;
}

export interface AstroDiscoveryResult {
  resources: DiscoveredResource[];
  sitemapUsed: boolean;
}

export type AstroBuildSourceErrorCode =
  | "sitemap-invalid"
  | "sitemap-missing"
  | "html-missing"
  | "ambiguous-layout"
  | "invalid-url"
  | "url-outside-origin"
  | "normalized-url-collision"
  | "io";

export class AstroBuildSourceError extends Error {
  constructor(
    public readonly code: AstroBuildSourceErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AstroBuildSourceError";
  }
}

/** Discovers raw sitemap or build resources without normalizing or fingerprinting them. */
export class AstroBuildSource implements Source {
  constructor(private readonly options: AstroBuildSourceOptions) {}

  async discover(): Promise<DiscoveredResource[]> {
    return (await this.discoverWithMetadata()).resources;
  }

  /** Discovers once and records whether the local sitemap supplied the inventory. */
  async discoverWithMetadata(): Promise<AstroDiscoveryResult> {
    let sitemap: string;

    try {
      sitemap = await readFile(this.options.sitemapPath, "utf8");
    } catch (error: unknown) {
      if (!isMissingFile(error)) {
        throw new AstroBuildSourceError("io", "Could not read the local sitemap.", { cause: error });
      }

      if (!this.options.fallbackToHtmlScan) {
        throw new AstroBuildSourceError(
          "sitemap-missing",
          `Sitemap does not exist: ${this.options.sitemapPath}`,
          { cause: error },
        );
      }

      return { resources: await this.discoverFromHtmlScan(), sitemapUsed: false };
    }

    return { resources: await this.discoverFromSitemap(sitemap), sitemapUsed: true };
  }

  private async discoverFromSitemap(xml: string): Promise<DiscoveredResource[]> {
    const entries = parseSitemap(xml);
    const resources: DiscoveredResource[] = [];

    for (const entry of entries) {
      resources.push({
        url: entry.url,
        filePath: await resolveHtmlFile(entry.url, this.options.distDir),
        ...(entry.lastmod === undefined ? {} : { lastmod: entry.lastmod }),
      });
    }

    return resources;
  }

  private async discoverFromHtmlScan(): Promise<DiscoveredResource[]> {
    const htmlFiles = await scanHtmlFiles(this.options.distDir);

    return htmlFiles
      .map((filePath) => ({
        url: urlForHtmlFile(filePath, this.options.distDir, this.options.siteUrl),
        filePath,
      }))
      .sort((left, right) => left.url.localeCompare(right.url));
  }
}

/** Reads the compiled HTML exactly as bytes; it intentionally does not decode the file. */
export async function readDiscoveredHtml(resource: DiscoveredResource): Promise<Uint8Array> {
  try {
    return await readFile(resource.filePath);
  } catch (error: unknown) {
    throw new AstroBuildSourceError("io", "Could not read compiled HTML.", { cause: error });
  }
}

/**
 * Read-only composition boundary for the pure core: normalize each discovered URL,
 * fingerprint its raw HTML bytes, and consolidate identical normalized resources.
 */
export async function composeDiscoveredResources(
  resources: DiscoveredResource[],
  options: ComposeDiscoveredResourcesOptions,
): Promise<UrlRecord[]> {
  const prepared = await Promise.all(
    resources.map(async (resource) => {
      let url: string;

      try {
        url = normalizeUrl(resource.url, options);
      } catch (error: unknown) {
        if (error instanceof UrlNormalizationError) {
          throw new AstroBuildSourceError("url-outside-origin", error.message, { cause: error });
        }

        throw error;
      }

      return {
        resource,
        record: {
          url,
          hash: fingerprintHtml(await readDiscoveredHtml(resource)),
          ...(resource.lastmod === undefined ? {} : { lastmod: resource.lastmod }),
        } satisfies UrlRecord,
      };
    }),
  );

  prepared.sort(comparePreparedResources);
  const byUrl = new Map<string, UrlRecord>();

  for (const { resource, record } of prepared) {
    const previous = byUrl.get(record.url);

    if (previous === undefined) {
      byUrl.set(record.url, record);
      continue;
    }

    if (previous.hash !== record.hash) {
      throw new AstroBuildSourceError(
        "normalized-url-collision",
        `Resources normalize to ${record.url} but have different HTML hashes: ${resource.filePath}`,
      );
    }
  }

  return [...byUrl.values()].sort((left, right) => left.url.localeCompare(right.url));
}

interface SitemapEntry {
  url: string;
  lastmod?: string;
}

function parseSitemap(xml: string): SitemapEntry[] {
  const validation = XMLValidator.validate(xml);

  if (validation !== true) {
    throw new AstroBuildSourceError("sitemap-invalid", "Sitemap XML is invalid.");
  }

  const parsed: unknown = new XMLParser({
    ignoreAttributes: true,
    isArray: (name) => name === "url",
  }).parse(xml);

  if (!isRecord(parsed)) {
    throw new AstroBuildSourceError("sitemap-invalid", "Sitemap must contain a urlset with URL entries.");
  }

  if (parsed.urlset === "") {
    return [];
  }

  if (!isRecord(parsed.urlset)) {
    throw new AstroBuildSourceError("sitemap-invalid", "Sitemap must contain a urlset with URL entries.");
  }

  if (parsed.urlset.url === undefined) {
    return [];
  }

  if (!Array.isArray(parsed.urlset.url)) {
    throw new AstroBuildSourceError("sitemap-invalid", "Sitemap must contain URL entries as an array.");
  }

  return parsed.urlset.url.map((entry) => {
    if (!isRecord(entry) || typeof entry.loc !== "string" || entry.loc.trim() === "") {
      throw new AstroBuildSourceError("sitemap-invalid", "Each sitemap URL must contain a non-empty loc.");
    }

    if (entry.lastmod !== undefined && typeof entry.lastmod !== "string") {
      throw new AstroBuildSourceError("sitemap-invalid", "Sitemap lastmod must be text when present.");
    }

    return {
      url: entry.loc.trim(),
      ...(typeof entry.lastmod === "string" ? { lastmod: entry.lastmod.trim() } : {}),
    };
  });
}

async function resolveHtmlFile(urlValue: string, distDir: string): Promise<string> {
  const pathname = pathnameForUrl(urlValue);
  const routeSegments = pathname.split("/").filter(Boolean);

  if (routeSegments.some((segment) => segment === "." || segment === ".." || segment.includes("\\"))) {
    throw new AstroBuildSourceError("invalid-url", `URL cannot resolve outside dist: ${urlValue}`);
  }

  const candidates = routeSegments.length === 0
    ? [resolveWithinDist(distDir, "index.html")]
    : [
        resolveWithinDist(distDir, `${routeSegments.join(sep)}.html`),
        resolveWithinDist(distDir, ...routeSegments, "index.html"),
      ];
  const existing = [] as string[];

  for (const candidate of candidates) {
    if (await isRegularFile(candidate)) {
      existing.push(candidate);
    }
  }

  if (existing.length === 0) {
    throw new AstroBuildSourceError("html-missing", `No compiled HTML exists for ${urlValue}.`);
  }

  if (existing.length === 1) {
    return existing[0];
  }

  let physicalPaths: string[];

  try {
    physicalPaths = await Promise.all(existing.map((candidate) => realpath(candidate)));
  } catch (error: unknown) {
    throw new AstroBuildSourceError("io", "Could not resolve compiled HTML paths.", { cause: error });
  }

  if (new Set(physicalPaths).size > 1) {
    throw new AstroBuildSourceError("ambiguous-layout", `Both Astro HTML layouts exist for ${urlValue}.`);
  }

  return existing[0];
}

function pathnameForUrl(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new AstroBuildSourceError("invalid-url", `Sitemap loc is not an absolute URL: ${value}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AstroBuildSourceError("invalid-url", `Sitemap loc must use HTTP(S): ${value}`);
  }

  try {
    return decodeURIComponent(url.pathname);
  } catch {
    throw new AstroBuildSourceError("invalid-url", `Sitemap loc has an invalid encoded path: ${value}`);
  }
}

function resolveWithinDist(distDir: string, ...parts: string[]): string {
  const resolvedDist = resolve(distDir);
  const candidate = resolve(resolvedDist, ...parts);
  const pathFromDist = relative(resolvedDist, candidate);

  if (pathFromDist === ".." || pathFromDist.startsWith(`..${sep}`)) {
    throw new AstroBuildSourceError("invalid-url", "Resolved HTML path escapes dist.");
  }

  return candidate;
}

async function scanHtmlFiles(directory: string): Promise<string[]> {
  let entries;

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    throw new AstroBuildSourceError("io", "Could not scan the static build directory.", { cause: error });
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await scanHtmlFiles(entryPath)));
    } else if (entry.isFile() && extname(entry.name) === ".html") {
      files.push(entryPath);
    }
  }

  return files;
}

function urlForHtmlFile(filePath: string, distDir: string, siteUrl: string): string {
  const pathFromDist = relative(resolve(distDir), filePath).split(sep).join("/");
  const withoutExtension = pathFromDist.slice(0, -".html".length);
  const route = withoutExtension === "index"
    ? "/"
    : withoutExtension.endsWith("/index")
      ? `/${withoutExtension.slice(0, -"/index".length)}/`
      : `/${withoutExtension}`;

  return new URL(route, siteUrl).href;
}

function comparePreparedResources(
  left: { resource: DiscoveredResource; record: UrlRecord },
  right: { resource: DiscoveredResource; record: UrlRecord },
): number {
  return (
    left.record.url.localeCompare(right.record.url) ||
    left.resource.url.localeCompare(right.resource.url) ||
    left.resource.filePath.localeCompare(right.resource.filePath)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return isErrnoException(error) && error.code === "ENOENT";
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch (error: unknown) {
    if (isMissingFile(error)) {
      return false;
    }

    throw new AstroBuildSourceError("io", "Could not inspect a compiled HTML path.", { cause: error });
  }
}
