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
    expect(fetch).toHaveBeenCalledWith(
      "https://indexnow.test/indexnow",
      expect.objectContaining({
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
        signal: expect.any(AbortSignal),
      }),
    );
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

  it("does not expose the IndexNow key or key location in client-generated errors", async () => {
    const { destination } = createDestination([]);

    const error = await destination.publish(
      changes({ created: [record("https://example.com/page"), record("https://example.com/page")] }),
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(IndexNowChangeSetInvariantError);
    expect(String(error)).not.toContain("test-key");
    expect(String(error)).not.toContain("test-key.txt");
  });

  it("retries a timeout and accepts a later response", async () => {
    const sleep = vi.fn(async () => undefined);
    let timeoutCount = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      if (init?.signal?.aborted) {
        throw new Error("aborted");
      }
      return new Response(undefined, { status: 202 });
    });
    const destination = retryDestination(fetch, sleep, (callback) => {
      timeoutCount += 1;
      if (timeoutCount === 1) {
        callback();
      }
      return 0 as unknown as ReturnType<typeof globalThis.setTimeout>;
    });

    await expect(destination.publish(changes({ created: [record("https://example.com/page")] }))).resolves.toEqual({
      accepted: true,
      submittedUrls: 1,
      batches: [{ size: 1, attempts: 2, status: 202 }],
    });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("reports exhausted timeouts and network failures without an HTTP status", async () => {
    const timeoutFetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      if (init?.signal?.aborted) throw new Error("timeout");
      return new Response(undefined, { status: 202 });
    });
    const timeoutDestination = retryDestination(timeoutFetch, vi.fn(async () => undefined), throwTimeout);
    const networkFetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("dns failure"));
    const networkDestination = retryDestination(networkFetch, vi.fn(async () => undefined));
    const changeSet = changes({ created: [record("https://example.com/page")] });

    await expect(timeoutDestination.publish(changeSet)).resolves.toEqual({
      accepted: false,
      submittedUrls: 1,
      batches: [{ size: 1, attempts: 3, status: null, failure: "timeout" }],
    });
    await expect(networkDestination.publish(changeSet)).resolves.toEqual({
      accepted: false,
      submittedUrls: 1,
      batches: [{ size: 1, attempts: 3, status: null, failure: "network" }],
    });
  });

  it.each([408, 425])("retries HTTP %i", async (status) => {
    const { destination, fetch } = retryStatuses([status, 202]);

    await expect(destination.publish(changes({ created: [record("https://example.com/page")] }))).resolves.toMatchObject({
      accepted: true,
      batches: [{ attempts: 2, status: 202 }],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uses Retry-After seconds and HTTP dates, otherwise backoff with jitter", async () => {
    const sleeps: number[] = [];
    const now = new Date("2026-07-12T12:00:00.000Z");
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(undefined, { status: 429, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(new Response(undefined, { status: 202 }))
      .mockResolvedValueOnce(new Response(undefined, { status: 429, headers: { "retry-after": "Sun, 12 Jul 2026 12:00:03 GMT" } }))
      .mockResolvedValueOnce(new Response(undefined, { status: 202 }))
      .mockResolvedValueOnce(new Response(undefined, { status: 429, headers: { "retry-after": "invalid" } }))
      .mockResolvedValueOnce(new Response(undefined, { status: 202 }));
    const destination = new IndexNowDestination({
      host: "example.com", key: "test-key", fetch, now: () => now, random: () => 0.5,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    });

    for (let index = 0; index < 3; index += 1) {
      await destination.publish(changes({ created: [record(`https://example.com/${index}`)] }));
    }
    expect(sleeps).toEqual([2_000, 3_000, 1_500]);
  });

  it("uses Retry-After for a retryable 503 response", async () => {
    const sleeps: number[] = [];
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(undefined, { status: 503, headers: { "retry-after": "4" } }))
      .mockResolvedValueOnce(new Response(undefined, { status: 202 }));
    const destination = new IndexNowDestination({
      host: "example.com", key: "test-key", fetch, random: () => 0.5,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    });

    await expect(destination.publish(changes({ created: [record("https://example.com/page")] }))).resolves.toMatchObject({
      accepted: true,
      batches: [{ attempts: 2, status: 202 }],
    });
    expect(sleeps).toEqual([4_000]);
  });

  it("retries 5xx responses, then fails fast after an exhausted batch", async () => {
    const { destination, fetch } = retryStatuses([500, 500, 202, 500, 500, 500]);
    const first = changes({ created: [record("https://example.com/first")] });
    const second = changes({ created: [record("https://example.com/second")] });

    await expect(destination.publish(first)).resolves.toMatchObject({ accepted: true, batches: [{ attempts: 3, status: 202 }] });
    await expect(destination.publish(second)).resolves.toMatchObject({ accepted: false, batches: [{ attempts: 3, status: 500 }] });
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it("does not retry definitive HTTP statuses", async () => {
    for (const status of [400, 403, 422, 204]) {
      const { destination, fetch } = retryStatuses([status]);
      await expect(destination.publish(changes({ created: [record(`https://example.com/${status}`)] }))).resolves.toMatchObject({
        accepted: false,
        batches: [{ attempts: 1, status }],
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("reports external cancellation as aborted, retries unknown remote outcomes, and omits later batches after failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const abortedFetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      if (init?.signal?.aborted) throw new Error("aborted");
      return new Response(undefined, { status: 202 });
    });
    const aborted = new IndexNowDestination({ host: "example.com", key: "test-key", fetch: abortedFetch, signal: controller.signal, sleep: async () => undefined });
    const unknownOutcomeFetch = vi.fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error("response lost after remote effect"))
      .mockResolvedValueOnce(new Response(undefined, { status: 202 }));
    const retried = retryDestination(unknownOutcomeFetch, vi.fn(async () => undefined));
    const batchFetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(undefined, { status: 202 }))
      .mockRejectedValueOnce(new Error("network"))
      .mockRejectedValueOnce(new Error("network"))
      .mockRejectedValueOnce(new Error("network"));
    const batchDestination = retryDestination(batchFetch, vi.fn(async () => undefined));

    await expect(aborted.publish(changes({ created: [record("https://example.com/aborted")] }))).resolves.toMatchObject({
      accepted: false, batches: [{ attempts: 1, status: null, failure: "aborted" }],
    });
    await expect(retried.publish(changes({ created: [record("https://example.com/unknown")] }))).resolves.toMatchObject({
      accepted: true, batches: [{ attempts: 2, status: 202 }],
    });
    const records = Array.from({ length: 2_001 }, (_, index) => record(`https://example.com/batch-${index}`));
    await expect(batchDestination.publish(changes({ created: records }))).resolves.toEqual({
      accepted: false,
      submittedUrls: 2_000,
      batches: [
        { size: 1_000, attempts: 1, status: 202 },
        { size: 1_000, attempts: 3, status: null, failure: "network" },
      ],
    });
    expect(batchFetch).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["external cancellation first", "aborted"],
    ["timeout first", "timeout"],
  ] as const)("preserves the first abort cause when %s", async (order, failure) => {
    const external = new AbortController();
    let triggerTimeout: (() => void) | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      if (order === "external cancellation first") {
        external.abort();
        triggerTimeout?.();
      } else {
        triggerTimeout?.();
        external.abort();
      }
      throw new Error("aborted");
    });
    const destination = new IndexNowDestination({
      host: "example.com",
      key: "test-key",
      fetch,
      signal: external.signal,
      sleep: async () => undefined,
      setTimeout: (callback) => {
        triggerTimeout = callback;
        return 0 as unknown as ReturnType<typeof globalThis.setTimeout>;
      },
      clearTimeout: () => undefined,
    });

    await expect(destination.publish(changes({ created: [record("https://example.com/page")] }))).resolves.toEqual({
      accepted: false,
      submittedUrls: 1,
      batches: [{ size: 1, attempts: 1, status: null, failure }],
    });
  });
});

function retryStatuses(statuses: number[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const status of statuses) fetch.mockResolvedValueOnce(new Response(undefined, { status }));
  return { fetch, destination: retryDestination(fetch, vi.fn(async () => undefined)) };
}

function retryDestination(
  fetch: typeof globalThis.fetch,
  sleep: (milliseconds: number) => Promise<void>,
  setTimeout?: (callback: () => void, milliseconds: number) => ReturnType<typeof globalThis.setTimeout>,
) {
  return new IndexNowDestination({
    host: "example.com", key: "test-key", fetch, sleep, random: () => 0,
    ...(setTimeout === undefined ? {} : { setTimeout }),
  });
}

function throwTimeout(callback: () => void): ReturnType<typeof globalThis.setTimeout> {
  callback();
  return 0 as unknown as ReturnType<typeof globalThis.setTimeout>;
}
