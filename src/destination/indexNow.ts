import type { ChangeSet, Destination, PublishResult } from "../core/types.js";

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const MAX_BATCH_SIZE = 1_000;

export interface IndexNowDestinationOptions {
  host: string;
  key: string;
  keyLocation?: string;
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
}

/** A ChangeSet from the core must classify each URL exactly once. */
export class IndexNowChangeSetInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexNowChangeSetInvariantError";
  }
}

/** IndexNow destination without retry or transport-error classification (both arrive in 4.2). */
export class IndexNowDestination implements Destination {
  private readonly endpoint: string;
  private readonly fetch: typeof globalThis.fetch;

  constructor(private readonly options: IndexNowDestinationOptions) {
    this.endpoint = options.endpoint ?? INDEXNOW_ENDPOINT;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async publish(changes: ChangeSet): Promise<PublishResult> {
    const urls = urlsToPublish(changes);
    const batches = [];
    let submittedUrls = 0;

    for (const urlsInBatch of chunk(urls, MAX_BATCH_SIZE)) {
      const response = await this.fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          host: this.options.host,
          key: this.options.key,
          ...(this.options.keyLocation === undefined ? {} : { keyLocation: this.options.keyLocation }),
          urlList: urlsInBatch,
        }),
      });

      submittedUrls += urlsInBatch.length;
      batches.push({ size: urlsInBatch.length, attempts: 1, status: response.status });

      if (!isAcceptedStatus(response.status)) {
        return { accepted: false, submittedUrls, batches };
      }
    }

    return { accepted: true, submittedUrls, batches };
  }
}

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
