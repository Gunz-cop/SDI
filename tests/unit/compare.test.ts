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

  it("orders every ChangeSet collection by URL", () => {
    const previous = {
      "https://example.com/deleted-z": record("https://example.com/deleted-z", "deleted-z"),
      "https://example.com/deleted-a": record("https://example.com/deleted-a", "deleted-a"),
      "https://example.com/unchanged-z": record("https://example.com/unchanged-z", "same-z"),
      "https://example.com/unchanged-a": record("https://example.com/unchanged-a", "same-a"),
      "https://example.com/updated-z": record("https://example.com/updated-z", "before-z"),
      "https://example.com/updated-a": record("https://example.com/updated-a", "before-a"),
    };
    const current = {
      "https://example.com/created-z": record("https://example.com/created-z", "created-z"),
      "https://example.com/created-a": record("https://example.com/created-a", "created-a"),
      "https://example.com/unchanged-z": record("https://example.com/unchanged-z", "same-z"),
      "https://example.com/unchanged-a": record("https://example.com/unchanged-a", "same-a"),
      "https://example.com/updated-z": record("https://example.com/updated-z", "after-z"),
      "https://example.com/updated-a": record("https://example.com/updated-a", "after-a"),
    };

    const changes = compareRecords(previous, current);

    expect(changes.created.map(({ url }) => url)).toEqual([
      "https://example.com/created-a",
      "https://example.com/created-z",
    ]);
    expect(changes.updated.map(({ after }) => after.url)).toEqual([
      "https://example.com/updated-a",
      "https://example.com/updated-z",
    ]);
    expect(changes.unchanged.map(({ url }) => url)).toEqual([
      "https://example.com/unchanged-a",
      "https://example.com/unchanged-z",
    ]);
    expect(changes.deleted.map(({ url }) => url)).toEqual([
      "https://example.com/deleted-a",
      "https://example.com/deleted-z",
    ]);
  });
});
