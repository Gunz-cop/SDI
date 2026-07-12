import type { BatchPublishResult, ChangeSet, Destination, PublishResult, TransportFailureKind } from "../core/types.js";

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const MAX_BATCH_SIZE = 1_000;
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 30_000;
const BACKOFF_BASE_MS = 1_000;

type TimeoutHandle = ReturnType<typeof globalThis.setTimeout>;

export interface IndexNowDestinationOptions {
  host: string;
  key: string;
  keyLocation?: string;
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  random?: () => number;
  timeoutMs?: number;
  setTimeout?: (callback: () => void, milliseconds: number) => TimeoutHandle;
  clearTimeout?: (handle: TimeoutHandle) => void;
}

/** A ChangeSet from the core must classify each URL exactly once. */
export class IndexNowChangeSetInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexNowChangeSetInvariantError";
  }
}

/** IndexNow destination with bounded retries for transient responses and transport failures. */
export class IndexNowDestination implements Destination {
  private readonly endpoint: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly timeoutMs: number;
  private readonly setTimeout: (callback: () => void, milliseconds: number) => TimeoutHandle;
  private readonly clearTimeout: (handle: TimeoutHandle) => void;

  constructor(private readonly options: IndexNowDestinationOptions) {
    this.endpoint = options.endpoint ?? INDEXNOW_ENDPOINT;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    this.setTimeout = options.setTimeout ?? globalThis.setTimeout;
    this.clearTimeout = options.clearTimeout ?? globalThis.clearTimeout;
  }

  async publish(changes: ChangeSet): Promise<PublishResult> {
    const urls = urlsToPublish(changes);
    const batches: BatchPublishResult[] = [];
    let submittedUrls = 0;

    for (const urlsInBatch of chunk(urls, MAX_BATCH_SIZE)) {
      const batch = await this.publishBatch(urlsInBatch);
      submittedUrls += urlsInBatch.length;
      batches.push(batch);

      if (batch.status === null || !isAcceptedStatus(batch.status)) {
        return { accepted: false, submittedUrls, batches };
      }
    }

    return { accepted: true, submittedUrls, batches };
  }

  private async publishBatch(urlList: string[]): Promise<BatchPublishResult> {
    for (let attempts = 1; attempts <= MAX_ATTEMPTS; attempts += 1) {
      const outcome = await this.sendAttempt(urlList);

      if (outcome.kind === "transport") {
        if (outcome.failure === "aborted" || attempts === MAX_ATTEMPTS) {
          return { size: urlList.length, attempts, status: null, failure: outcome.failure };
        }

        await this.sleep(this.backoffDelay(attempts));
        continue;
      }

      if (isAcceptedStatus(outcome.response.status) || !isRetryableStatus(outcome.response.status) || attempts === MAX_ATTEMPTS) {
        return { size: urlList.length, attempts, status: outcome.response.status };
      }

      await this.sleep(retryDelay(outcome.response, attempts, this.now, this.random));
    }

    throw new Error("IndexNow retry loop ended unexpectedly.");
  }

  private async sendAttempt(urlList: string[]): Promise<AttemptOutcome> {
    if (this.options.signal?.aborted === true) {
      return { kind: "transport", failure: "aborted" };
    }

    const controller = new AbortController();
    let abortCause: "timeout" | "aborted" | undefined;
    const abortForExternalSignal = () => {
      abortCause ??= "aborted";
      controller.abort();
    };

    this.options.signal?.addEventListener("abort", abortForExternalSignal, { once: true });
    if (this.options.signal?.aborted === true) {
      abortForExternalSignal();
      this.options.signal?.removeEventListener("abort", abortForExternalSignal);
      return { kind: "transport", failure: "aborted" };
    }

    const timeout = this.setTimeout(() => {
      abortCause ??= "timeout";
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          host: this.options.host,
          key: this.options.key,
          ...(this.options.keyLocation === undefined ? {} : { keyLocation: this.options.keyLocation }),
          urlList,
        }),
        signal: controller.signal,
      });
      return { kind: "http", response };
    } catch {
      return { kind: "transport", failure: abortCause ?? "network" };
    } finally {
      this.clearTimeout(timeout);
      this.options.signal?.removeEventListener("abort", abortForExternalSignal);
    }
  }

  private backoffDelay(attempt: number): number {
    return BACKOFF_BASE_MS * 2 ** (attempt - 1) + Math.floor(this.random() * BACKOFF_BASE_MS);
  }
}

type AttemptOutcome = { kind: "http"; response: Response } | { kind: "transport"; failure: TransportFailureKind };

function urlsToPublish(changes: ChangeSet): string[] {
  validateChangeSet(changes);

  return [
    ...changes.created.map(({ url }) => url).sort(),
    ...changes.updated.map(({ after }) => after.url).sort(),
    ...changes.deleted.map(({ url }) => url).sort(),
  ];
}

function validateChangeSet(changes: ChangeSet): void {
  const categoriesByUrl = new Map<string, string>();

  validateCategory("created", changes.created.map(({ url }) => url), categoriesByUrl);
  validateUpdated(changes.updated, categoriesByUrl);
  validateCategory("unchanged", changes.unchanged.map(({ url }) => url), categoriesByUrl);
  validateCategory("deleted", changes.deleted.map(({ url }) => url), categoriesByUrl);
}

function validateUpdated(changes: ChangeSet["updated"], categoriesByUrl: Map<string, string>): void {
  for (const { before, after } of changes) {
    if (before.url !== after.url) {
      throw new IndexNowChangeSetInvariantError("Updated records must retain the same URL.");
    }

    validateUrl("updated", after.url, categoriesByUrl);
  }
}

function validateCategory(category: string, urls: string[], categoriesByUrl: Map<string, string>): void {
  for (const url of urls) {
    validateUrl(category, url, categoriesByUrl);
  }
}

function validateUrl(category: string, url: string, categoriesByUrl: Map<string, string>): void {
  const previousCategory = categoriesByUrl.get(url);

  if (previousCategory !== undefined) {
    const reason = previousCategory === category ? `duplicated in ${category}` : `in both ${previousCategory} and ${category}`;
    throw new IndexNowChangeSetInvariantError(`ChangeSet URL ${reason}: ${url}`);
  }

  categoriesByUrl.set(url, category);
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
}

function isAcceptedStatus(status: number): boolean {
  return status === 200 || status === 202;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

function retryDelay(response: Response, attempt: number, now: () => Date, random: () => number): number {
  const retryAfter = parseRetryAfter(response.headers.get("retry-after"), now());

  if (retryAfter !== null) {
    return retryAfter;
  }

  return BACKOFF_BASE_MS * 2 ** (attempt - 1) + Math.floor(random() * BACKOFF_BASE_MS);
}

function parseRetryAfter(value: string | null, now: Date): number | null {
  if (value === null) {
    return null;
  }

  if (/^\d+$/.test(value)) {
    return Number(value) * 1_000;
  }

  const retryAt = Date.parse(value);
  return Number.isNaN(retryAt) ? null : Math.max(0, retryAt - now.getTime());
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}
