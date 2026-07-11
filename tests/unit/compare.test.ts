import { describe, expect, it } from "vitest";
import { compareRecords } from "../../src/core/compare.js";
import type { UrlRecord } from "../../src/core/types.js";

function record(url: string, hash: string, lastmod?: string): UrlRecord {
  return { url, hash, ...(lastmod === undefined ? {} : { lastmod }) };
}

describe("compareRecords", () => {
  it("classifies every record as created for a first snapshot", () => {
    const current = {
      "https://example.com/a": record("https://example.com/a", "a"),
      "https://example.com/b": record("https://example.com/b", "b"),
    };

    expect(compareRecords({}, current)).toEqual({
      created: [current["https://example.com/a"], current["https://example.com/b"]],
      updated: [],
      unchanged: [],
      deleted: [],
    });
  });

  it("classifies created, updated, unchanged, and deleted records in URL order", () => {
    const previous = {
      "https://example.com/deleted": record("https://example.com/deleted", "old-deleted"),
      "https://example.com/unchanged": record("https://example.com/unchanged", "same", "2026-07-10"),
      "https://example.com/updated": record("https://example.com/updated", "before"),
    };
    const current = {
      "https://example.com/created": record("https://example.com/created", "new"),
      "https://example.com/unchanged": record("https://example.com/unchanged", "same", "2026-07-11"),
      "https://example.com/updated": record("https://example.com/updated", "after"),
    };

    expect(compareRecords(previous, current)).toEqual({
      created: [current["https://example.com/created"]],
      updated: [{ before: previous["https://example.com/updated"], after: current["https://example.com/updated"] }],
      unchanged: [current["https://example.com/unchanged"]],
      deleted: [previous["https://example.com/deleted"]],
    });
  });

  it("returns only unchanged for an identical second snapshot", () => {
    const snapshot = {
      "https://example.com/a": record("https://example.com/a", "a"),
      "https://example.com/b": record("https://example.com/b", "b"),
    };

    expect(compareRecords(snapshot, snapshot)).toEqual({
      created: [],
      updated: [],
      unchanged: [snapshot["https://example.com/a"], snapshot["https://example.com/b"]],
      deleted: [],
    });
  });
});
