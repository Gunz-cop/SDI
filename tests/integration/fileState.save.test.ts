import { access, copyFile, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DiscoveryState } from "../../src/core/types.js";
import { FileStateStore } from "../../src/state/fileState.js";

const fixturesRoot = resolve("tests/fixtures/state");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("FileStateStore.save", () => {
  it("round-trips a validated state through atomic save and load", async () => {
    const directory = await temporaryDirectory();
    const statePath = resolve(directory, "state.json");
    const state = stateFor({ updatedAt: "2026-07-12T13:00:00.000Z" });
    const store = stateStore(statePath);

    await store.save(state);

    await expect(store.load()).resolves.toEqual(state);
  });

  it("moves the previous v1 state to .bak before promoting the new state", async () => {
    const directory = await temporaryDirectory();
    const statePath = resolve(directory, "state.json");
    await copyFile(fixturePath("state-v1-valid.json"), statePath);
    const previousBytes = await readFile(statePath);
    const next = stateFor({ updatedAt: "2026-07-12T13:00:00.000Z" });

    await stateStore(statePath).save(next);

    await expect(readFile(`${statePath}.bak`)).resolves.toEqual(previousBytes);
    await expect(stateStore(statePath).load()).resolves.toEqual(next);
  });

  it("backs up legacy only before the first authorized v1 save", async () => {
    const directory = await temporaryDirectory();
    const statePath = resolve(directory, "state.json");
    const legacyPath = resolve(directory, "legacy.json");
    await copyFile(fixturePath("legacy-valid.json"), legacyPath);
    const legacyBytes = await readFile(legacyPath);
    const store = stateStore(statePath, {
      siteId: "legacy-site",
      siteUrl: "https://legacy.example.test",
      trailingSlash: "never",
      legacyStatePath: legacyPath,
    });
    const state = stateFor({
      siteId: "legacy-site",
      siteUrl: "https://legacy.example.test",
      trailingSlash: "never",
      updatedAt: "2026-07-12T13:00:00.000Z",
      resources: {
        "https://legacy.example.test/": {
          url: "https://legacy.example.test/",
          hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      },
    });

    await store.save(state);

    await expect(readFile(legacyPath)).resolves.toEqual(legacyBytes);
    await expect(readFile(`${statePath}.legacy.bak`)).resolves.toEqual(legacyBytes);

    await writeFile(legacyPath, "legacy changed after migration");
    await store.save({ ...state, updatedAt: "2026-07-12T14:00:00.000Z" });

    await expect(readFile(`${statePath}.legacy.bak`)).resolves.toEqual(legacyBytes);
  });

  it("rejects an invalid state before creating any filesystem side effect", async () => {
    const directory = await temporaryDirectory();
    const statePath = resolve(directory, "state.json");
    const legacyPath = resolve(directory, "legacy.json");
    await copyFile(fixturePath("legacy-valid.json"), legacyPath);
    await writeFile(resolve(directory, "sentinel.txt"), "unchanged");
    const before = await snapshotDirectory(directory);
    const invalid = { ...stateFor(), revision: 2 } as DiscoveryState;

    await expect(
      stateStore(statePath, {
        legacyStatePath: legacyPath,
      }).save(invalid),
    ).rejects.toMatchObject({ code: "state-corrupt" });

    await expect(snapshotDirectory(directory)).resolves.toEqual(before);
  });

  it("does not create a missing directory when the state is invalid", async () => {
    const parent = await temporaryDirectory();
    const missingDirectory = resolve(parent, "missing");
    const invalid = { ...stateFor(), revision: 2 } as DiscoveryState;

    await expect(stateStore(resolve(missingDirectory, "state.json")).save(invalid)).rejects.toMatchObject({
      code: "state-corrupt",
    });

    await expect(access(missingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores the previous state and removes the temporary file when promotion fails", async () => {
    const directory = await temporaryDirectory();
    const statePath = resolve(directory, "state.json");
    const original = stateFor({ updatedAt: "2026-07-12T13:00:00.000Z" });
    await writeFile(statePath, serialize(original));
    const store = stateStore(statePath, {
      filesystem: {
        rename: async (from, to) => {
          if (from === `${statePath}.tmp` && to === statePath) {
            throw new Error("injected promotion failure");
          }

          await rename(from, to);
        },
      },
    });

    await expect(store.save(stateFor({ updatedAt: "2026-07-12T14:00:00.000Z" }))).rejects.toMatchObject({
      code: "state-save-failed",
    });
    await expect(stateStore(statePath).load()).resolves.toEqual(original);
    await expect(access(`${statePath}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(`${statePath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves .bak and reports a distinct error when rollback also fails", async () => {
    const directory = await temporaryDirectory();
    const statePath = resolve(directory, "state.json");
    const original = stateFor({ updatedAt: "2026-07-12T13:00:00.000Z" });
    await writeFile(statePath, serialize(original));
    const store = stateStore(statePath, {
      filesystem: {
        rename: async (from, to) => {
          if (from === `${statePath}.tmp` && to === statePath) {
            throw new Error("injected promotion failure");
          }

          if (from === `${statePath}.bak` && to === statePath) {
            throw new Error("injected rollback failure");
          }

          await rename(from, to);
        },
      },
    });

    await expect(store.save(stateFor({ updatedAt: "2026-07-12T14:00:00.000Z" }))).rejects.toMatchObject({
      code: "state-save-rollback-failed",
    });
    await expect(access(statePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(`${statePath}.bak`, "utf8")).resolves.toBe(serialize(original));
    await expect(access(`${statePath}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function stateStore(
  statePath: string,
  overrides: Partial<ConstructorParameters<typeof FileStateStore>[0]> = {},
): FileStateStore {
  return new FileStateStore({
    statePath,
    siteId: "state-site",
    siteUrl: "https://state.example.test",
    trailingSlash: "preserve",
    ...overrides,
  });
}

function stateFor(overrides: Partial<DiscoveryState> = {}): DiscoveryState {
  return {
    schemaVersion: 1,
    siteId: "state-site",
    siteUrl: "https://state.example.test",
    trailingSlash: "preserve",
    fingerprintProfile: "sha256-raw-html-v1",
    updatedAt: "2026-07-12T12:00:00.000Z",
    resources: {
      "https://state.example.test/": {
        url: "https://state.example.test/",
        hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    },
    ...overrides,
  };
}

function fixturePath(name: string): string {
  return resolve(fixturesRoot, name);
}

function serialize(state: DiscoveryState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "sdi-state-save-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function snapshotDirectory(directory: string): Promise<Array<{ path: string; contents: string }>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const snapshot = await Promise.all(
    entries.sort((left, right) => left.name.localeCompare(right.name)).map(async (entry) => {
      const path = resolve(directory, entry.name);

      if (entry.isDirectory()) {
        return (await snapshotDirectory(path)).map((child) => ({
          path: `${entry.name}/${child.path}`,
          contents: child.contents,
        }));
      }

      return [{ path: entry.name, contents: (await readFile(path)).toString("hex") }];
    }),
  );

  return snapshot.flat();
}
