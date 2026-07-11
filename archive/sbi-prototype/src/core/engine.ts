import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  DestinationAdapter,
  DiscoveryRunOptions,
  DiscoveryRunSummary,
  StateStore,
  SubmissionLogEntry,
  SubmissionResult,
  UrlState,
} from "./types.js";

export async function runDiscovery(
  currentUrls: UrlState[],
  previousUrls: string[],
  stateStore: StateStore,
  destinations: DestinationAdapter[],
  options: DiscoveryRunOptions,
): Promise<DiscoveryRunSummary> {
  const changed: UrlState[] = [];
  const deleted: string[] = [];
  const currentUrlMap = new Map(currentUrls.map((item) => [item.url, item]));
  const optionalDestinations = new Set(options.optionalDestinations ?? []);

  for (const current of currentUrls) {
    const previous = await stateStore.get(current.url);
    if (options.forceSubmit || !previous || previous.hash !== current.hash) {
      changed.push(current);
    }
  }

  for (const previousUrl of previousUrls) {
    if (!currentUrlMap.has(previousUrl)) {
      deleted.push(previousUrl);
    }
  }

  if (changed.length === 0 && deleted.length === 0) {
    return {
      manifestUrls: currentUrls.map((item) => item.url),
      changed,
      deleted,
      logEntries: [],
      dryRun: Boolean(options.dryRun),
    };
  }

  const resultsByDestination = options.dryRun
    ? buildDryRunResults(destinations, changed)
    : await executeDestinations(destinations, changed);

  const submittedOn = new Date().toISOString().split("T")[0] ?? "";
  const logEntries: SubmissionLogEntry[] = [];

  for (const item of changed) {
    const relativePath = toRelativePath(item.url);
    const published = item.lastmod?.split("T")[0] ?? submittedOn;
    const results = buildResultsMap(destinations, resultsByDestination, item.url);
    const requiredDestinationsSucceeded =
      destinations.length === 0 ||
      Object.entries(results)
        .filter(([name]) => !optionalDestinations.has(name))
        .every(([, result]) => result.success);

    if (!options.dryRun && requiredDestinationsSucceeded) {
      await stateStore.set(item.url, item);
    }

    logEntries.push({
      url: relativePath,
      published,
      submitted: submittedOn,
      destinations: destinations.map((destination) => destination.name),
      results,
    });
  }

  if (!options.dryRun) {
    for (const url of deleted) {
      await stateStore.delete(url);
    }

    if (logEntries.length > 0) {
      await appendSubmissionLogs(options.logPath, logEntries);
    }
  }

  return {
    manifestUrls: currentUrls.map((item) => item.url),
    changed,
    deleted,
    logEntries,
    dryRun: Boolean(options.dryRun),
  };
}

function buildDryRunResults(
  destinations: DestinationAdapter[],
  urls: UrlState[],
): Record<string, SubmissionResult> {
  const results: Record<string, SubmissionResult> = {};
  for (const destination of destinations) {
    results[destination.name] = {
      success: true,
      submittedCount: urls.length,
    };
  }
  return results;
}

async function executeDestinations(
  destinations: DestinationAdapter[],
  urls: UrlState[],
): Promise<Record<string, SubmissionResult>> {
  const settled = await Promise.allSettled(
    destinations.map(async (destination) => {
      try {
        return {
          name: destination.name,
          result: await destination.submit(urls),
        };
      } catch (error) {
        return {
          name: destination.name,
          result: {
            success: false,
            submittedCount: 0,
            errors: urls.map((url) => ({
              url: url.url,
              error: error instanceof Error ? error.message : "Unknown destination error",
            })),
          },
        };
      }
    }),
  );

  const results: Record<string, SubmissionResult> = {};
  for (const item of settled) {
    if (item.status === "fulfilled") {
      results[item.value.name] = item.value.result;
    }
  }
  return results;
}

function buildResultsMap(
  destinations: DestinationAdapter[],
  resultsByDestination: Record<string, SubmissionResult>,
  url: string,
): Record<string, { success: boolean; error?: string }> {
  const results: Record<string, { success: boolean; error?: string }> = {};

  for (const destination of destinations) {
    const submission = resultsByDestination[destination.name];
    if (!submission) {
      results[destination.name] = {
        success: false,
        error: "Destination failed to execute",
      };
      continue;
    }

    const errorForUrl = submission.errors?.find((entry) => entry.url === url);
    if (submission.success && !errorForUrl) {
      results[destination.name] = { success: true };
      continue;
    }

    results[destination.name] = {
      success: false,
      error: errorForUrl?.error ?? "Submission failed",
    };
  }

  return results;
}

function toRelativePath(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return url;
  }
}

async function appendSubmissionLogs(logPath: string, entries: SubmissionLogEntry[]): Promise<void> {
  await fs.mkdir(path.dirname(logPath), { recursive: true });

  let existing: SubmissionLogEntry[] = [];
  try {
    const content = await fs.readFile(logPath, "utf-8");
    existing = JSON.parse(content) as SubmissionLogEntry[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  existing.push(...entries);
  await fs.writeFile(logPath, JSON.stringify(existing, null, 2), "utf-8");
}
