import type { ChangeSet, UrlRecord } from "./types.js";

/**
 * Compares two normalized URL inventories. URL identity is the record URL and
 * only the HTML hash determines whether an existing resource was updated.
 */
export function compareRecords(
  previous: Readonly<Record<string, UrlRecord>>,
  current: Readonly<Record<string, UrlRecord>>,
): ChangeSet {
  const created: UrlRecord[] = [];
  const updated: ChangeSet["updated"] = [];
  const unchanged: UrlRecord[] = [];
  const deleted: UrlRecord[] = [];

  for (const url of sortedKeys(current)) {
    const after = current[url];
    const before = previous[url];

    if (before === undefined) {
      created.push(after);
    } else if (before.hash === after.hash) {
      unchanged.push(after);
    } else {
      updated.push({ before, after });
    }
  }

  for (const url of sortedKeys(previous)) {
    if (current[url] === undefined) {
      deleted.push(previous[url]);
    }
  }

  return { created, updated, unchanged, deleted };
}

function sortedKeys(records: Readonly<Record<string, UrlRecord>>): string[] {
  return Object.keys(records).sort((left, right) => left.localeCompare(right));
}
