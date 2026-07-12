export interface ExpectedResourceFixture {
  url: string;
  file: string;
  bytes: string;
  hash: string;
  lastmod?: string;
}

export type ExpectedSourceError =
  | { code: "sitemap-invalid" }
  | { code: "html-missing"; url: string; fileCandidates: string[] }
  | { code: "url-outside-origin"; url: string }
  | { code: "ambiguous-layout"; url: string; fileCandidates: string[] };

export type ExpectedOutcome =
  | { kind: "success"; resources: ExpectedResourceFixture[] }
  | { kind: "error"; error: ExpectedSourceError };

export interface SourceFixture {
  name: string;
  siteUrl: string;
  sitemap: "present" | "missing" | "invalid";
  fallbackToHtmlScan: boolean;
  outcome: ExpectedOutcome;
}

export const sourceFixtures: SourceFixture[] = [
  {
    name: "astro-file",
    siteUrl: "https://file.example.test",
    sitemap: "present",
    fallbackToHtmlScan: true,
    outcome: {
      kind: "success",
      resources: [
        {
          url: "https://file.example.test/",
          file: "dist/index.html",
          bytes: "<!doctype html><title>File root</title>\n",
          hash: "d3b230daffab11719798794f24e8df0b40ad854f735e7b9ec9a69147d2976a41",
          lastmod: "2026-07-10",
        },
        {
          url: "https://file.example.test/about",
          file: "dist/about.html",
          bytes: "<!doctype html><title>File about</title>\n",
          hash: "cade9ed64f6d6a78cebac4759460d0e106421c07a42e8b25daf9084d883c1393",
          lastmod: "2026-07-11",
        },
      ],
    },
  },
  {
    name: "astro-directory",
    siteUrl: "https://directory.example.test",
    sitemap: "present",
    fallbackToHtmlScan: true,
    outcome: {
      kind: "success",
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
  },
  {
    name: "fallback-html-scan",
    siteUrl: "https://fallback.example.test",
    sitemap: "missing",
    fallbackToHtmlScan: true,
    outcome: {
      kind: "success",
      resources: [
        {
          url: "https://fallback.example.test/",
          file: "dist/index.html",
          bytes: "<!doctype html><title>Fallback root</title>\n",
          hash: "d5026ee5317d1861936c944f54aa8f998d0664087644200b6318675ac57e40e2",
        },
        {
          url: "https://fallback.example.test/articles/first/",
          file: "dist/articles/first/index.html",
          bytes: "<!doctype html><title>Fallback first article</title>\n",
          hash: "4d1d0fb53a5a786eff10ec0b6df1d05bb4913fde5e6e4f8937f6b0749bdcad1e",
        },
      ],
    },
  },
  {
    name: "invalid-sitemap",
    siteUrl: "https://invalid.example.test",
    sitemap: "invalid",
    fallbackToHtmlScan: true,
    outcome: { kind: "error", error: { code: "sitemap-invalid" } },
  },
  {
    name: "missing-html",
    siteUrl: "https://missing.example.test",
    sitemap: "present",
    fallbackToHtmlScan: false,
    outcome: {
      kind: "error",
      error: {
        code: "html-missing",
        url: "https://missing.example.test/not-built",
        fileCandidates: ["dist/not-built.html", "dist/not-built/index.html"],
      },
    },
  },
  {
    name: "outside-origin",
    siteUrl: "https://expected.example.test",
    sitemap: "present",
    fallbackToHtmlScan: false,
    outcome: {
      kind: "error",
      error: { code: "url-outside-origin", url: "https://elsewhere.example.test/page" },
    },
  },
  {
    name: "duplicates",
    siteUrl: "https://duplicates.example.test",
    sitemap: "present",
    fallbackToHtmlScan: false,
    outcome: {
      kind: "success",
      resources: [
        {
          url: "https://duplicates.example.test/guide",
          file: "dist/guide.html",
          bytes: "<!doctype html><title>Duplicate guide</title>\n",
          hash: "90937b52289a23ba3b4da3c8d8874583edcb06dd4e640ad280dd8d61e5d02b29",
        },
        {
          url: "https://duplicates.example.test/guide",
          file: "dist/guide.html",
          bytes: "<!doctype html><title>Duplicate guide</title>\n",
          hash: "90937b52289a23ba3b4da3c8d8874583edcb06dd4e640ad280dd8d61e5d02b29",
        },
      ],
    },
  },
  {
    name: "ambiguous-layout",
    siteUrl: "https://ambiguous.example.test",
    sitemap: "present",
    fallbackToHtmlScan: false,
    outcome: {
      kind: "error",
      error: {
        code: "ambiguous-layout",
        url: "https://ambiguous.example.test/article",
        fileCandidates: ["dist/article.html", "dist/article/index.html"],
      },
    },
  },
  {
    name: "house-representative",
    siteUrl: "https://housegatitos.example",
    sitemap: "present",
    fallbackToHtmlScan: false,
    outcome: {
      kind: "success",
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
  },
  {
    name: "cuida-representative",
    siteUrl: "https://cuidadelperroviejo.example",
    sitemap: "present",
    fallbackToHtmlScan: false,
    outcome: {
      kind: "success",
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
  },
];
