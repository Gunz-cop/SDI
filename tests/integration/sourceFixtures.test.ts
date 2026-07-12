import { access, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fingerprintHtml } from "../../src/core/fingerprint.js";

const fixturesRoot = fileURLToPath(new URL("../fixtures/source/", import.meta.url));

interface ExpectedResourceFixture {
  url: string;
  file: string;
  bytes: string;
  hash: string;
}

interface BuildFixture {
  name: string;
  siteUrl: string;
  sitemap: "present" | "missing" | "invalid";
  fallbackToHtmlScan: boolean;
  resources?: ExpectedResourceFixture[];
}

const buildFixtures: BuildFixture[] = [
  {
    name: "astro-file",
    siteUrl: "https://file.example.test",
    sitemap: "present",
    fallbackToHtmlScan: true,
    resources: [
      {
        url: "https://file.example.test/",
        file: "dist/index.html",
        bytes: "<!doctype html><title>File root</title>\n",
        hash: "d3b230daffab11719798794f24e8df0b40ad854f735e7b9ec9a69147d2976a41",
      },
      {
        url: "https://file.example.test/about",
        file: "dist/about.html",
        bytes: "<!doctype html><title>File about</title>\n",
        hash: "cade9ed64f6d6a78cebac4759460d0e106421c07a42e8b25daf9084d883c1393",
      },
    ],
  },
  {
    name: "astro-directory",
    siteUrl: "https://directory.example.test",
    sitemap: "present",
    fallbackToHtmlScan: true,
    resources: [
      {
        url: "https://directory.example.test/",
        file: "dist/index.html",
        bytes: "<!doctype html><title>Directory root</title>\n",
        hash: "f7414ccbad2b3d4d2227b6dfb6360eecbda004c739ff2a9f92af6c7f02056743",
      },
      {
        url: "https://directory.example.test/guides/",
        file: "dist/guides/index.html",
        bytes: "<!doctype html><title>Directory guides</title>\n",
        hash: "3e20a4b7496bd1b15e26331d21939abf6ffcee661c0e5573c91a0247e941901b",
      },
    ],
  },
  {
    name: "fallback-html-scan",
    siteUrl: "https://fallback.example.test",
    sitemap: "missing",
    fallbackToHtmlScan: true,
  },
  {
    name: "invalid-sitemap",
    siteUrl: "https://invalid.example.test",
    sitemap: "invalid",
    fallbackToHtmlScan: true,
  },
  {
    name: "missing-html",
    siteUrl: "https://missing.example.test",
    sitemap: "present",
    fallbackToHtmlScan: false,
  },
  {
    name: "outside-origin",
    siteUrl: "https://expected.example.test",
    sitemap: "present",
    fallbackToHtmlScan: false,
  },
  {
    name: "duplicates",
    siteUrl: "https://duplicates.example.test",
    sitemap: "present",
    fallbackToHtmlScan: false,
  },
  {
    name: "ambiguous-layout",
    siteUrl: "https://ambiguous.example.test",
    sitemap: "present",
    fallbackToHtmlScan: false,
  },
  {
    name: "house-representative",
    siteUrl: "https://housegatitos.example",
    sitemap: "present",
    fallbackToHtmlScan: false,
    resources: [
      {
        url: "https://housegatitos.example/",
        file: "dist/index.html",
        bytes: "<!doctype html><title>House Gatitos</title>\n",
        hash: "c0da532aba278ea03f3272045bd2e06eeeb0888131a87ee176169a894dccfbfc",
      },
      {
        url: "https://housegatitos.example/gatos/",
        file: "dist/gatos/index.html",
        bytes: "<!doctype html><title>Gatos cuidados</title>\n",
        hash: "3034b2cb95eb3b19f1090dd6f0baf21e90f83f8f7bf41aec83a3520184f3d38c",
      },
    ],
  },
  {
    name: "cuida-representative",
    siteUrl: "https://cuidadelperroviejo.example",
    sitemap: "present",
    fallbackToHtmlScan: false,
    resources: [
      {
        url: "https://cuidadelperroviejo.example/",
        file: "dist/index.html",
        bytes: "<!doctype html><title>Cuida tu perro viejo</title>\n",
        hash: "10071ba02c69e381660479988f1aa494e7e60c82a42a0a8a76ba29927c879e17",
      },
      {
        url: "https://cuidadelperroviejo.example/cuidados",
        file: "dist/cuidados.html",
        bytes: "<!doctype html><title>Cuidados senior</title>\n",
        hash: "985f042589825342f563d24c4098628b57d7df5b11d8aebfb3afadcdedb0e2fa",
      },
    ],
  },
];

describe("Astro source fixtures", () => {
  it("fixes deterministic URL, file, raw-byte, and hash expectations for supported layouts", async () => {
    for (const fixture of buildFixtures) {
      for (const resource of fixture.resources ?? []) {
        const absolutePath = resolve(fixturesRoot, fixture.name, resource.file);

        expect(relative(resolve(fixturesRoot, fixture.name), absolutePath).split(sep).join("/")).toBe(resource.file);
        expect(await readFile(absolutePath)).toEqual(Buffer.from(resource.bytes, "utf8"));
        expect(fingerprintHtml(await readFile(absolutePath))).toBe(resource.hash);
      }
    }
  });

  it("marks the sitemap and fallback preconditions that astroBuild will enforce", async () => {
    for (const fixture of buildFixtures) {
      const sitemapPath = resolve(fixturesRoot, fixture.name, "dist/sitemap-0.xml");

      if (fixture.sitemap === "missing") {
        await expect(access(sitemapPath)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(access(sitemapPath)).resolves.toBeUndefined();
      }
    }

    expect(buildFixtures.find((fixture) => fixture.name === "fallback-html-scan")?.fallbackToHtmlScan).toBe(true);
    expect(buildFixtures.find((fixture) => fixture.name === "invalid-sitemap")?.sitemap).toBe("invalid");
  });
});
