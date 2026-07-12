import { access, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fingerprintHtml } from "../../src/core/fingerprint.js";
import { sourceFixtures } from "../fixtures/source/catalog.js";

const fixturesRoot = fileURLToPath(new URL("../fixtures/source/", import.meta.url));

describe("Astro source fixtures", () => {
  it("declares complete and uniquely named outcomes", () => {
    const names = sourceFixtures.map((fixture) => fixture.name);

    expect(new Set(names).size).toBe(names.length);

    for (const fixture of sourceFixtures) {
      expect(fixture.siteUrl).toMatch(/^https:\/\//);
      expect(["present", "missing", "invalid"]).toContain(fixture.sitemap);

      if (fixture.outcome.kind === "success") {
        expect(fixture.outcome.resources.length).toBeGreaterThan(0);

        for (const resource of fixture.outcome.resources) {
          expect(resource.url).toMatch(/^https:\/\//);
          expect(resource.file).toMatch(/^dist\//);
          expect(resource.bytes).not.toBe("");
          expect(resource.hash).toMatch(/^[a-f0-9]{64}$/);
        }
      } else {
        expect(fixture.outcome.error.code).not.toBe("");
      }
    }
  });

  it("fixes deterministic raw bytes and hashes for every successful discovery", async () => {
    for (const fixture of sourceFixtures) {
      if (fixture.outcome.kind !== "success") {
        continue;
      }

      for (const resource of fixture.outcome.resources) {
        const fixtureRoot = resolve(fixturesRoot, fixture.name);
        const absolutePath = resolve(fixtureRoot, resource.file);
        const bytes = await readFile(absolutePath);

        expect(relative(fixtureRoot, absolutePath).split(sep).join("/")).toBe(resource.file);
        expect(bytes).toEqual(Buffer.from(resource.bytes, "utf8"));
        expect(fingerprintHtml(bytes)).toBe(resource.hash);
      }
    }
  });

  it("physically represents the sitemap state required by each fixture", async () => {
    for (const fixture of sourceFixtures) {
      const sitemapPath = resolve(fixturesRoot, fixture.name, "dist/sitemap-0.xml");

      if (fixture.sitemap === "missing") {
        await expect(access(sitemapPath)).rejects.toMatchObject({ code: "ENOENT" });
        continue;
      }

      await expect(access(sitemapPath)).resolves.toBeUndefined();

      if (fixture.sitemap === "invalid") {
        expect((await readFile(sitemapPath, "utf8")).trimEnd()).not.toContain("</urlset>");
      }
    }
  });
});
