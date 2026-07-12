import { access, mkdtemp, open as openFile, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireStateLock,
  getStateLockPath,
  inspectStateLock,
  removeStaleLock,
  StateLockError,
  type StateLockMetadata,
  type StateLockOptions,
} from "../../src/state/fileState.js";

const now = new Date("2026-07-12T12:00:00.000Z");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("state lock", () => {
  it("acquires exclusively, persists the documented format, and releases as the owner", async () => {
    const directory = await temporaryDirectory();
    const lockPath = getStateLockPath(resolve(directory, "state.json"));
    const options = lockOptions(lockPath, { pidIsRunning: async () => true });
    const lease = await acquireStateLock(options);
    const expectedContents = `${JSON.stringify({
      pid: process.pid,
      startedAt: now.toISOString(),
      siteId: "state-site",
      hostname: "local-host",
    }, null, 2)}\n`;

    await expect(readFile(lockPath, "utf8")).resolves.toBe(expectedContents);
    await lease.release();
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a second acquire without changing the existing lock", async () => {
    const directory = await temporaryDirectory();
    const lockPath = resolve(directory, "run.lock");
    const options = lockOptions(lockPath, { pidIsRunning: async () => true });
    const lease = await acquireStateLock(options);
    const before = await readFile(lockPath, "utf8");

    await expect(acquireStateLock(options)).rejects.toMatchObject({ code: "lock-active" } satisfies Partial<StateLockError>);
    await expect(readFile(lockPath, "utf8")).resolves.toBe(before);

    await lease.release();
  });

  it("closes a partial lock before best-effort cleanup and preserves the write error", async () => {
    const directory = await temporaryDirectory();
    const lockPath = resolve(directory, "run.lock");
    const events: string[] = [];
    const writeError = new Error("injected lock write failure");

    await expect(
      acquireStateLock(lockOptions(lockPath, {
        filesystem: {
          open: async (path, flags) => {
            const handle = await openFile(path, flags);
            return {
              writeFile: async () => {
                events.push("write");
                throw writeError;
              },
              sync: () => handle.sync(),
              close: async () => {
                events.push("close");
                await handle.close();
              },
            };
          },
          remove: async (path) => {
            events.push("remove");
            await rm(path);
          },
        },
      })),
    ).rejects.toBe(writeError);

    expect(events).toEqual(["write", "close", "remove"]);
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("classifies a local lock with an active PID as active", async () => {
    const directory = await temporaryDirectory();
    const lockPath = resolve(directory, "run.lock");
    await writeLock(lockPath, lockMetadata({ hostname: "local-host", startedAt: "2026-07-12T10:00:00.000Z" }));

    await expect(inspectStateLock(lockOptions(lockPath, { pidIsRunning: async () => true }))).resolves.toMatchObject({
      kind: "active",
    });
  });

  it("classifies a local lock with a missing PID as stale", async () => {
    const directory = await temporaryDirectory();
    const lockPath = resolve(directory, "run.lock");
    await writeLock(lockPath, lockMetadata({ hostname: "local-host", startedAt: "2026-07-12T11:59:00.000Z" }));

    await expect(inspectStateLock(lockOptions(lockPath, { pidIsRunning: async () => false }))).resolves.toMatchObject({
      kind: "stale",
    });
  });

  it.each([
    ["local missing PID", "local-host", "2026-07-12T11:59:00.000Z"],
    ["remote old", "remote-host", "2026-07-12T11:00:00.000Z"],
  ] as const)("keeps a lock for another site invalid regardless of %s", async (_scenario, hostname, startedAt) => {
    const directory = await temporaryDirectory();
    const lockPath = resolve(directory, "run.lock");
    await writeLock(lockPath, lockMetadata({ siteId: "other-site", hostname, startedAt }));

    await expect(
      inspectStateLock(lockOptions(lockPath, { pidIsRunning: async () => { throw new Error("PID must not be checked"); } })),
    ).resolves.toMatchObject({ kind: "invalid" });
  });

  it.each([
    ["younger", "2026-07-12T11:31:00.000Z", "active"],
    ["older", "2026-07-12T11:30:00.000Z", "stale"],
  ] as const)("classifies a remote %s lock using only the age threshold", async (_age, startedAt, kind) => {
    const directory = await temporaryDirectory();
    const lockPath = resolve(directory, "run.lock");
    await writeLock(lockPath, lockMetadata({ hostname: "remote-host", startedAt }));

    await expect(
      inspectStateLock(lockOptions(lockPath, { pidIsRunning: async () => { throw new Error("PID must not be checked"); } })),
    ).resolves.toMatchObject({ kind });
  });

  it("keeps malformed and unreadable locks invalid and never removes them", async () => {
    const directory = await temporaryDirectory();
    const malformedPath = resolve(directory, "malformed.lock");
    await writeFile(malformedPath, "not json");
    const malformed = await inspectStateLock(lockOptions(malformedPath));

    expect(malformed.kind).toBe("invalid");
    await expect(removeStaleLock(malformed, lockOptions(malformedPath))).resolves.toBe(false);
    await expect(readFile(malformedPath, "utf8")).resolves.toBe("not json");

    const unreadablePath = resolve(directory, "unreadable.lock");
    const unreadable = await inspectStateLock(lockOptions(unreadablePath, {
      filesystem: {
        readFile: async () => {
          throw { code: "EACCES" };
        },
      },
    }));

    expect(unreadable.kind).toBe("invalid");
    await expect(removeStaleLock(unreadable, lockOptions(unreadablePath))).resolves.toBe(false);
  });

  it("does not remove a lock that changed after stale inspection", async () => {
    const directory = await temporaryDirectory();
    const lockPath = resolve(directory, "run.lock");
    await writeLock(lockPath, lockMetadata({ hostname: "remote-host", startedAt: "2026-07-12T11:00:00.000Z" }));
    const options = lockOptions(lockPath);
    const inspection = await inspectStateLock(options);

    await writeLock(lockPath, lockMetadata({ hostname: "remote-host", startedAt: "2026-07-12T11:59:00.000Z", pid: 99 }));

    await expect(removeStaleLock(inspection, options)).resolves.toBe(false);
    await expect(inspectStateLock(options)).resolves.toMatchObject({ kind: "active", metadata: { pid: 99 } });
  });

  it("does not remove either lock when options target a different path", async () => {
    const directory = await temporaryDirectory();
    const firstPath = resolve(directory, "first.lock");
    const secondPath = resolve(directory, "second.lock");
    const metadata = lockMetadata({ hostname: "remote-host", startedAt: "2026-07-12T11:00:00.000Z" });
    await writeLock(firstPath, metadata);
    await writeLock(secondPath, metadata);
    const firstOptions = lockOptions(firstPath);
    const inspection = await inspectStateLock(firstOptions);

    await expect(removeStaleLock(inspection, lockOptions(secondPath))).resolves.toBe(false);
    await expect(access(firstPath)).resolves.toBeUndefined();
    await expect(access(secondPath)).resolves.toBeUndefined();
  });

  it("removes a valid stale lock only when explicitly requested", async () => {
    const directory = await temporaryDirectory();
    const lockPath = resolve(directory, "run.lock");
    await writeLock(lockPath, lockMetadata({ hostname: "remote-host", startedAt: "2026-07-12T11:00:00.000Z" }));
    const options = lockOptions(lockPath);
    const inspection = await inspectStateLock(options);

    expect(inspection.kind).toBe("stale");
    await expect(removeStaleLock(inspection, options)).resolves.toBe(true);
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function lockOptions(lockPath: string, overrides: Partial<StateLockOptions> = {}): StateLockOptions {
  return {
    lockPath,
    siteId: "state-site",
    now: () => now,
    hostname: () => "local-host",
    ...overrides,
  };
}

function lockMetadata(overrides: Partial<StateLockMetadata> = {}): StateLockMetadata {
  return {
    pid: 42,
    startedAt: "2026-07-12T11:00:00.000Z",
    siteId: "state-site",
    hostname: "local-host",
    ...overrides,
  };
}

async function writeLock(path: string, metadata: StateLockMetadata): Promise<void> {
  await writeFile(path, `${JSON.stringify(metadata, null, 2)}\n`);
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "sdi-state-lock-"));
  temporaryDirectories.push(directory);
  return directory;
}
