import { describe, expect, it } from "vitest";
import { UrlNormalizationError, normalizeUrl } from "../../src/core/normalize.js";

const siteUrl = "https://example.com";

describe("normalizeUrl", () => {
  it.each([
    ["preserve", "https://example.com/articles", "https://example.com/articles"],
    ["preserve", "https://example.com/articles/", "https://example.com/articles/"],
    ["always", "https://example.com/articles", "https://example.com/articles/"],
    ["always", "https://example.com/articles/", "https://example.com/articles/"],
    ["never", "https://example.com/articles/", "https://example.com/articles"],
    ["never", "https://example.com/articles", "https://example.com/articles"],
    ["never", "https://example.com/", "https://example.com/"],
  ] as const)("applies %s slash policy", (trailingSlash, input, expected) => {
    expect(normalizeUrl(input, { siteUrl, trailingSlash })).toBe(expected);
  });

  it("removes fragments while preserving query strings", () => {
    expect(
      normalizeUrl("https://example.com/article?ref=feed#summary", {
        siteUrl,
        trailingSlash: "always",
      }),
    ).toBe("https://example.com/article/?ref=feed");
  });

  it("rejects another origin and non-HTTP(S) URLs", () => {
    expect(() => normalizeUrl("https://other.example/article", { siteUrl, trailingSlash: "always" })).toThrow(
      UrlNormalizationError,
    );
    expect(() => normalizeUrl("file:///tmp/article.html", { siteUrl, trailingSlash: "always" })).toThrow(
      UrlNormalizationError,
    );
  });
});
