import { describe, expect, it, vi } from "vitest";
import { IndexNowChangeSetInvariantError, IndexNowDestination } from "../../src/destination/indexNow.js";
import type { ChangeSet, UrlRecord } from "../../src/core/types.js";

function record(url: string): UrlRecord {
  return { url, hash: "a".repeat(64) };
}

function changes(overrides: Partial<ChangeSet> = {}): ChangeSet {
  return {
    created: [],
    updated: [],
    unchanged: [],
    deleted: [],
    ...overrides,
  };
}

function createDestination(statuses: number[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();

  for (const status of statuses) {
    fetch.mockResolvedValueOnce(new Response(undefined, { status }));
  }

  return {
    fetch,
    destination: new IndexNowDestination({
      host: "example.com",
      key: "test-key",
      keyLocation: "https://example.com/test-key.txt",
      endpoint: "https://indexnow.test/indexnow",
      fetch,
    }),
  };
}

describe("IndexNowDestination", () => {
  it("publishes created, updated, and deleted URLs in the official JSON payload", async () => {
    const { destination, fetch } = createDestination([202]);
    const result = await destination.publish(
      changes({
        created: [record("https://example.com/created")],
        updated: [{ before: record("https://example.com/updated"), after: record("https://example.com/updated") }],
        deleted: [record("https://example.com/deleted")],
      }),
    );

    expect(result).toEqual({
      accepted: true,
      submittedUrls: 3,
      batches: [{ size: 3, attempts: 1, status: 202 }],
    });
    expect(fetch).toHaveBeenCalledWith("https://indexnow.test/indexnow", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        host: "example.com",
        key: "test-key",
        keyLocation: "https://example.com/test-key.txt",
        urlList: [
          "https://example.com/created",
          "https://example.com/updated",
          "https://example.com/deleted",
        ],
      }),
    });
  });

  it("orders created, updated, and deleted URLs without mutating the ChangeSet", async () => {
    const { destination, fetch } = createDestination([200]);
    const input = changes({
      created: [record("https://example.com/created-z"), record("https://example.com/created-a")],
      updated: [
        { before: record("https://example.com/updated-z"), after: record("https://example.com/updated-z") },
        { before: record("https://example.com/updated-a"), after: record("https://example.com/updated-a") },
      ],
      deleted: [record("https://example.com/deleted-z"), record("https://example.com/deleted-a")],
    });

    await destination.publish(input);

    expect(input.created.map(({ url }) => url)).toEqual(["https://example.com/created-z", "https://example.com/created-a"]);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      urlList: [
        "https://example.com/created-a",
        "https://example.com/created-z",
        "https://example.com/updated-a",
        "https://example.com/updated-z",
        "https://example.com/deleted-a",
        "https://example.com/deleted-z",
      ],
    });
  });

  it("uses batches of at most 1,000 URLs and accepts HTTP 200", async () => {
    const { destination, fetch } = createDestination([200, 200]);
    const created = Array.from({ length: 1_001 }, (_, index) => record(`https://example.com/${index}`));

    const result = await destination.publish(changes({ created }));

    expect(result).toEqual({
      accepted: true,
      submittedUrls: 1_001,
      batches: [
        { size: 1_000, attempts: 1, status: 200 },
        { size: 1, attempts: 1, status: 200 },
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps exactly 1,000 URLs in one batch", async () => {
    const { destination, fetch } = createDestination([200]);
    const created = Array.from({ length: 1_000 }, (_, index) => record(`https://example.com/${index}`));

    await expect(destination.publish(changes({ created }))).resolves.toEqual({
      accepted: true,
      submittedUrls: 1_000,
      batches: [{ size: 1_000, attempts: 1, status: 200 }],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fails fast on a non-accepted HTTP response and counts only attempted batches", async () => {
    const { destination, fetch } = createDestination([200, 400]);
    const created = Array.from({ length: 2_001 }, (_, index) => record(`https://example.com/${index}`));

    const result = await destination.publish(changes({ created }));

    expect(result).toEqual({
      accepted: false,
      submittedUrls: 2_000,
      batches: [
        { size: 1_000, attempts: 1, status: 200 },
        { size: 1_000, attempts: 1, status: 400 },
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not submit a request when there are no changed URLs", async () => {
    const { destination, fetch } = createDestination([]);

    await expect(destination.publish(changes())).resolves.toEqual({ accepted: true, submittedUrls: 0, batches: [] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([204, 403, 422])("rejects HTTP %i", async (status) => {
    const { destination } = createDestination([status]);

    await expect(destination.publish(changes({ created: [record("https://example.com/page")] }))).resolves.toEqual({
      accepted: false,
      submittedUrls: 1,
      batches: [{ size: 1, attempts: 1, status }],
    });
  });

  it.each<[keyof Pick<ChangeSet, "created" | "updated" | "unchanged" | "deleted">, ChangeSet]>([
    ["created", changes({ created: [record("https://example.com/page"), record("https://example.com/page")] })],
    [
      "updated",
      changes({
        updated: [
          { before: record("https://example.com/page"), after: record("https://example.com/page") },
          { before: record("https://example.com/page"), after: record("https://example.com/page") },
        ],
      }),
    ],
    ["unchanged", changes({ unchanged: [record("https://example.com/page"), record("https://example.com/page")] })],
    ["deleted", changes({ deleted: [record("https://example.com/page"), record("https://example.com/page")] })],
  ])("rejects a duplicate URL in %s before fetching", async (_category, changeSet) => {
    const { destination, fetch } = createDestination([]);

    await expect(destination.publish(changeSet)).rejects.toBeInstanceOf(IndexNowChangeSetInvariantError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a URL present in more than one category before fetching", async () => {
    const { destination, fetch } = createDestination([]);

    await expect(
      destination.publish(
        changes({
          created: [record("https://example.com/page")],
          deleted: [record("https://example.com/page")],
        }),
      ),
    ).rejects.toBeInstanceOf(IndexNowChangeSetInvariantError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an updated record whose URL changes before fetching", async () => {
    const { destination, fetch } = createDestination([]);

    await expect(
      destination.publish(
        changes({
          updated: [{ before: record("https://example.com/before"), after: record("https://example.com/after") }],
        }),
      ),
    ).rejects.toBeInstanceOf(IndexNowChangeSetInvariantError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
