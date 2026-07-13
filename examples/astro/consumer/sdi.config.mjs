export default {
  siteId: "sdi-astro-tarball-consumer",
  siteUrl: "https://consumer.example.test",
  source: {
    distDir: "./dist",
    sitemapPath: "./dist/sitemap-0.xml",
    fallbackToHtmlScan: true,
  },
  normalization: {
    trailingSlash: "always",
  },
  statePath: "./.sdi/state.json",
  reportPath: "./.sdi/last-run.json",
};
