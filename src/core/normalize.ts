import type { TrailingSlashPolicy } from "./types.js";

export interface NormalizationOptions {
  siteUrl: string;
  trailingSlash: TrailingSlashPolicy;
}

/** Thrown when a URL cannot represent a resource belonging to the configured site. */
export class UrlNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlNormalizationError";
  }
}

/**
 * Produces SDI's canonical URL identity: same origin as the configured site,
 * without a fragment, and with the configured trailing slash policy.
 */
export function normalizeUrl(value: string, options: NormalizationOptions): string {
  const site = parseHttpUrl(options.siteUrl, "siteUrl");
  const url = parseHttpUrl(value, "URL");

  if (url.origin !== site.origin) {
    throw new UrlNormalizationError(
      `URL origin ${url.origin} does not match configured site origin ${site.origin}.`,
    );
  }

  url.hash = "";
  url.pathname = normalizePathname(url.pathname, options.trailingSlash);
  return url.href;
}

function parseHttpUrl(value: string, label: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new UrlNormalizationError(`${label} must be an absolute HTTP(S) URL.`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlNormalizationError(`${label} must use HTTP(S).`);
  }

  return url;
}

function normalizePathname(pathname: string, policy: TrailingSlashPolicy): string {
  if (policy === "preserve" || pathname === "/") {
    return pathname;
  }

  if (policy === "always") {
    return pathname.endsWith("/") ? pathname : `${pathname}/`;
  }

  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}
