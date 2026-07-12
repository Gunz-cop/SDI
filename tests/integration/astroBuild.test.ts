import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
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
