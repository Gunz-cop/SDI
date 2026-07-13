import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeUrl } from "../../src/core/normalize.js";
import type { UrlRecord } from "../../src/core/types.js";
import {
  AstroBuildSource,
  AstroBuildSourceError,
  composeDiscoveredResources,
  readDiscoveredHtml,
} from "../../src/source/astroBuild.js";
import { sourceFixtures } from "../fixtures/source/catalog.js";

const fixturesRoot = resolve("tests/fixtures/source");

describe("AstroBuildSource", () => {
  it("discovers every successful fixture without normalizing or fingerprinting", async () => {
    for (const fixture of sourceFixtures) {
      if (fixture.outcome.kind !== "success") {
        continue;
      }

      const resources = await sourceFor(fixture.name, fixture.siteUrl, fixture.fallbackToHtmlScan).discover();

      expect(resources).toEqual(
        fixture.outcome.resources.map((resource) => ({
          url: resource.url,
          filePath: resolve(fixturesRoot, fixture.name, resource.file),
          ...(resource.lastmod === undefined ? {} : { lastmod: resource.lastmod }),
        })),
      );
    }
  });

  it("records whether discovery used the sitemap without changing the Source seam", async () => {
    const sitemap = await sourceFor("astro-file", "https://file.example.test", true).discoverWithMetadata();
    const fallback = await sourceFor("fallback-html-scan", "https://fallback.example.test", true).discoverWithMetadata();

    expect(sitemap).toMatchObject({ sitemapUsed: true });
    expect(fallback).toMatchObject({ sitemapUsed: false });
    await expect(sourceFor("astro-file", "https://file.example.test", true).discover()).resolves.toEqual(sitemap.resources);
  });

  it("returns a completed empty sitemap inventory with sitemap metadata", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "sdi-source-empty-"));
    const dist = resolve(directory, "dist");

    try {
      await mkdir(dist, { recursive: true });
      await writeFile(resolve(dist, "sitemap.xml"), "<?xml version=\"1.0\"?><urlset></urlset>");
      const result = await new AstroBuildSource({
        siteUrl: "https://empty.example.test",
        distDir: dist,
        sitemapPath: resolve(dist, "sitemap.xml"),
        fallbackToHtmlScan: false,
      }).discoverWithMetadata();

      expect(result).toEqual({ resources: [], sitemapUsed: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("normalizes local sitemap IO failures into source errors", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "sdi-source-io-"));
    const dist = resolve(directory, "dist");

    try {
      await mkdir(resolve(dist, "sitemap.xml"), { recursive: true });
      await expect(new AstroBuildSource({
        siteUrl: "https://io.example.test",
        distDir: dist,
        sitemapPath: resolve(dist, "sitemap.xml"),
        fallbackToHtmlScan: true,
      }).discover()).rejects.toMatchObject({ code: "io" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns raw bytes without decoding them", async () => {
    const fixture = sourceFixtures.find((candidate) => candidate.name === "astro-file");

    if (fixture?.outcome.kind !== "success") {
      throw new Error("astro-file fixture must be successful.");
    }

    const [resource] = await sourceFor(fixture.name, fixture.siteUrl, fixture.fallbackToHtmlScan).discover();

    await expect(readDiscoveredHtml(resource)).resolves.toEqual(Buffer.from(fixture.outcome.resources[0].bytes, "utf8"));
  });

  it("reports every catalogued source or composition error", async () => {
    for (const fixture of sourceFixtures) {
      if (fixture.outcome.kind !== "error") {
        continue;
      }

      const source = sourceFor(fixture.name, fixture.siteUrl, fixture.fallbackToHtmlScan);

      if (fixture.outcome.error.code === "url-outside-origin") {
        await expect(
          source.discover().then((resources) =>
            composeDiscoveredResources(resources, { siteUrl: fixture.siteUrl, trailingSlash: "preserve" }),
          ),
        ).rejects.toMatchObject({ code: fixture.outcome.error.code });
      } else {
        await expect(source.discover()).rejects.toMatchObject({ code: fixture.outcome.error.code });
      }
    }
  });

  it("does not scan HTML when a sitemap is absent and fallback is disabled", async () => {
    await expect(sourceFor("fallback-html-scan", "https://fallback.example.test", false).discover()).rejects.toMatchObject({
      code: "sitemap-missing",
    });
  });
});

describe("composeDiscoveredResources", () => {
  it.each(sourceFixtures.filter(isComposableFixture))(
    "$name produces deterministic normalized URL records from discovery",
    async (fixture) => {
      const records = await composeDiscoveredResources(
        await sourceFor(fixture.name, fixture.siteUrl, fixture.fallbackToHtmlScan).discover(),
        { siteUrl: fixture.siteUrl, trailingSlash: fixture.trailingSlash },
      );

      expect(records).toEqual(expectedComposedRecords(fixture));
    },
  );

  it("normalizes, fingerprints, and consolidates exact duplicates deterministically", async () => {
    const fixture = sourceFixtures.find((candidate) => candidate.name === "duplicates");

    if (fixture?.outcome.kind !== "success") {
      throw new Error("duplicates fixture must be successful.");
    }

    const records = await composeDiscoveredResources(
      await sourceFor(fixture.name, fixture.siteUrl, fixture.fallbackToHtmlScan).discover(),
      { siteUrl: fixture.siteUrl, trailingSlash: "preserve" },
    );

    expect(records).toEqual([
      {
        url: fixture.outcome.resources[0].url,
        hash: fixture.outcome.resources[0].hash,
      },
    ]);
  });

  it("rejects different HTML that collides after core normalization", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "sdi-source-collision-"));
    const firstPath = resolve(directory, "first.html");
    const secondPath = resolve(directory, "second.html");

    try {
      await writeFile(firstPath, "first");
      await writeFile(secondPath, "second");

      await expect(
        composeDiscoveredResources(
          [
            { url: "https://collision.example.test/article", filePath: firstPath },
            { url: "https://collision.example.test/article/", filePath: secondPath },
          ],
          { siteUrl: "https://collision.example.test", trailingSlash: "always" },
        ),
      ).rejects.toBeInstanceOf(AstroBuildSourceError);
      await expect(
        composeDiscoveredResources(
          [
            { url: "https://collision.example.test/article", filePath: firstPath },
            { url: "https://collision.example.test/article/", filePath: secondPath },
          ],
          { siteUrl: "https://collision.example.test", trailingSlash: "always" },
        ),
      ).rejects.toMatchObject({ code: "normalized-url-collision" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function sourceFor(name: string, siteUrl: string, fallbackToHtmlScan: boolean): AstroBuildSource {
  const distDir = resolve(fixturesRoot, name, "dist");

  return new AstroBuildSource({
    siteUrl,
    distDir,
    sitemapPath: resolve(distDir, "sitemap-0.xml"),
    fallbackToHtmlScan,
  });
}

function isComposableFixture(
  fixture: (typeof sourceFixtures)[number],
): fixture is (typeof sourceFixtures)[number] & {
  trailingSlash: "preserve" | "always" | "never";
  outcome: Extract<(typeof sourceFixtures)[number]["outcome"], { kind: "success" }>;
} {
  return fixture.outcome.kind === "success" && fixture.trailingSlash !== undefined;
}

function expectedComposedRecords(
  fixture: (typeof sourceFixtures)[number] & {
    trailingSlash: "preserve" | "always" | "never";
    outcome: Extract<(typeof sourceFixtures)[number]["outcome"], { kind: "success" }>;
  },
): UrlRecord[] {
  const records = new Map<string, UrlRecord>();

  for (const resource of fixture.outcome.resources) {
    const url = normalizeUrl(resource.url, {
      siteUrl: fixture.siteUrl,
      trailingSlash: fixture.trailingSlash,
    });
    const record: UrlRecord = {
      url,
      hash: resource.hash,
      ...(resource.lastmod === undefined ? {} : { lastmod: resource.lastmod }),
    };
    const previous = records.get(url);

    if (previous !== undefined && previous.hash !== record.hash) {
      throw new Error(`Fixture ${fixture.name} has an unexpected normalized collision for ${url}.`);
    }

    if (previous === undefined) {
      records.set(url, record);
    }
  }

  return [...records.values()].sort((left, right) => left.url.localeCompare(right.url));
}
