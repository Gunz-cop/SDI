import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { UrlState } from "../core/types.js";

export interface StaticSiteSourceOptions {
  distDir: string;
  siteUrl: string;
  sitemapPath?: string;
}

export async function getStaticSiteUrls(options: StaticSiteSourceOptions): Promise<UrlState[]> {
  const sitemapPath = options.sitemapPath ?? path.join(options.distDir, "sitemap-0.xml");

  try {
    const sitemapContent = await fs.readFile(sitemapPath, "utf-8");
    return readUrlsFromSitemap(sitemapContent, options.siteUrl, options.distDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return scanDistDirForHtmlFiles(options.distDir, options.siteUrl);
  }
}

async function readUrlsFromSitemap(
  sitemapContent: string,
  siteUrl: string,
  distDir: string,
): Promise<UrlState[]> {
  const urls: string[] = [];
  const locRegex = /<loc>(https?:\/\/[^<]+)<\/loc>/g;

  let match: RegExpExecArray | null = null;
  while ((match = locRegex.exec(sitemapContent)) !== null) {
    urls.push(match[1]);
  }

  const states: UrlState[] = [];
  for (const url of urls) {
    const state = await getStateForUrl(url, siteUrl, distDir);
    if (state) {
      states.push(state);
    }
  }

  return states;
}

async function getStateForUrl(url: string, siteUrl: string, distDir: string): Promise<UrlState | null> {
  if (!url.startsWith(siteUrl)) {
    return null;
  }

  const relativePath = url.slice(siteUrl.length);
  const htmlFilePath = await resolveHtmlFilePath(relativePath, distDir);

  if (!htmlFilePath) {
    return {
      url,
      hash: hashContent(url),
      lastmod: new Date().toISOString(),
    };
  }

  const content = await fs.readFile(htmlFilePath);
  const stats = await fs.stat(htmlFilePath);
  return {
    url,
    hash: hashContent(content),
    lastmod: stats.mtime.toISOString(),
  };
}

async function resolveHtmlFilePath(relativePath: string, distDir: string): Promise<string | null> {
  if (relativePath === "" || relativePath === "/") {
    return path.join(distDir, "index.html");
  }

  const normalizedPath = relativePath.replace(/^\/+/, "");
  const candidates = [
    path.join(distDir, normalizedPath, "index.html"),
    path.join(distDir, `${normalizedPath}.html`),
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  return null;
}

async function scanDistDirForHtmlFiles(distDir: string, siteUrl: string): Promise<UrlState[]> {
  const discovered: UrlState[] = [];

  async function walk(currentDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "_astro" || entry.name === "_worker.js" || entry.name.startsWith(".")) {
          continue;
        }

        await walk(fullPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".html") || entry.name === "404.html") {
        continue;
      }

      const content = await fs.readFile(fullPath);
      const stats = await fs.stat(fullPath);
      discovered.push({
        url: toPublicUrl(fullPath, distDir, siteUrl),
        hash: hashContent(content),
        lastmod: stats.mtime.toISOString(),
      });
    }
  }

  await walk(distDir);
  return discovered;
}

function toPublicUrl(fullPath: string, distDir: string, siteUrl: string): string {
  let relativePath = path.relative(distDir, fullPath).replace(/\\/g, "/");

  if (relativePath === "index.html") {
    relativePath = "";
  } else if (relativePath.endsWith("/index.html")) {
    relativePath = relativePath.slice(0, -11);
  } else if (relativePath.endsWith(".html")) {
    relativePath = relativePath.slice(0, -5);
  }

  return `${siteUrl}/${relativePath}`.replace(/\/+$/, "");
}

function hashContent(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}
