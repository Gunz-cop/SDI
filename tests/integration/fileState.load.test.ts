import { access, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileStateError, FileStateStore } from "../../src/state/fileState.js";

const fixturesRoot = resolve("tests/fixtures/state");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("FileStateStore.load", () => {
  it("loads and validates a compatible schema v1 state", async () => {
    const state = await stateStore(fixturePath("state-v1-valid.json"), {
      siteId: "state-site",
      siteUrl: "https://state.example.test",
      trailingSlash: "preserve",
    }).load();

    expect(state).toEqual({
      schemaVersion: 1,
      siteId: "state-site",
      siteUrl: "https://state.example.test",
      trailingSlash: "preserve",
      fingerprintProfile: "sha256-raw-html-v1",
      updatedAt: "2026-07-12T00:00:00.000Z",
      resources: {
        "https://state.example.test/": {
          url: "https://state.example.test/",
          hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        "https://state.example.test/about": {
          url: "https://state.example.test/about",
          hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          lastmod: "2026-07-11",
        },
      },
    });
  });

  it("returns null when neither schema v1 nor legacy state exists", async () => {
    const directory = await temporaryDirectory();

    await expect(
      stateStore(resolve(directory, "state.json"), {
        siteId: "state-site",
        siteUrl: "https://state.example.test",
        trailingSlash: "preserve",
        legacyStatePath: resolve(directory, "legacy.json"),
      }).load(),
    ).resolves.toBeNull();
  });

  it("imports legacy state in memory without creating a backup", async () => {
    const directory = await temporaryDirectory();
    const statePath = resolve(directory, "state.json");
    const legacyPath = fixturePath("legacy-valid.json");
    const legacyBytes = await readFile(legacyPath);

    const state = await stateStore(statePath, {
      siteId: "legacy-site",
      siteUrl: "https://legacy.example.test",
      trailingSlash: "never",
      legacyStatePath: legacyPath,
    }).load();

    expect(state).toMatchObject({
      schemaVersion: 1,
      siteId: "legacy-site",
      siteUrl: "https://legacy.example.test",
      trailingSlash: "never",
      fingerprintProfile: "sha256-raw-html-v1",
      updatedAt: "2026-07-12T12:00:00.000Z",
      resources: {
        "https://legacy.example.test/articles": {
          url: "https://legacy.example.test/articles",
          hash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          lastmod: "2026-07-10",
        },
      },
    });
    await expect(readFile(legacyPath)).resolves.toEqual(legacyBytes);
    await expect(access(statePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(`${statePath}.legacy.bak`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("gives schema v1 precedence over legacy state", async () => {
    const state = await stateStore(fixturePath("state-v1-valid.json"), {
      siteId: "state-site",
      siteUrl: "https://state.example.test",
      trailingSlash: "preserve",
      legacyStatePath: fixturePath("corrupt.json"),
    }).load();

    expect(state?.siteId).toBe("state-site");
  });

  it("recovers a corrupt primary state from a valid .bak", async () => {
    const directory = await temporaryDirectory();
    const statePath = resolve(directory, "state.json");
    await copyFile(fixturePath("corrupt.json"), statePath);
    await copyFile(fixturePath("state-v1-valid.json"), `${statePath}.bak`);

    const state = await stateStore(statePath, {
      siteId: "state-site",
      siteUrl: "https://state.example.test",
      trailingSlash: "preserve",
    }).load();

    expect(state?.resources["https://state.example.test/about"]?.lastmod).toBe("2026-07-11");
  });

  it("aborts when both primary state and backup are corrupt", async () => {
    const directory = await temporaryDirectory();
    const statePath = resolve(directory, "state.json");
    await copyFile(fixturePath("corrupt.json"), statePath);
    await copyFile(fixturePath("corrupt.json"), `${statePath}.bak`);

    await expect(
      stateStore(statePath, {
        siteId: "state-site",
        siteUrl: "https://state.example.test",
        trailingSlash: "preserve",
        legacyStatePath: fixturePath("legacy-valid.json"),
      }).load(),
    ).rejects.toMatchObject({ code: "state-corrupt" } satisfies Partial<FileStateError>);
  });

  it("aborts on a compatible-format state whose site metadata changed", async () => {
    const directory = await temporaryDirectory();
    const statePath = resolve(directory, "state.json");
    await copyFile(fixturePath("state-v1-incompatible.json"), statePath);
    await copyFile(fixturePath("state-v1-valid.json"), `${statePath}.bak`);

    await expect(
      stateStore(statePath, {
        siteId: "state-site",
        siteUrl: "https://state.example.test",
        trailingSlash: "preserve",
      }).load(),
    ).rejects.toMatchObject({ code: "state-incompatible" } satisfies Partial<FileStateError>);
  });

  it.each([
    ["legacy-key-mismatch.json", "legacy-invalid"],
    ["legacy-collision.json", "legacy-collision"],
    ["state-v1-valid.json", "legacy-invalid"],
  ] as const)("rejects invalid legacy format %s", async (legacyFile, code) => {
    const directory = await temporaryDirectory();

    await expect(
      stateStore(resolve(directory, "state.json"), {
        siteId: "legacy-site",
        siteUrl: "https://legacy.example.test",
        trailingSlash: "never",
        legacyStatePath: fixturePath(legacyFile),
      }).load(),
    ).rejects.toMatchObject({ code });
  });
});

function stateStore(
  statePath: string,
  options: {
    siteId: string;
    siteUrl: string;
    trailingSlash: "preserve" | "always" | "never";
    legacyStatePath?: string;
  },
): FileStateStore {
  return new FileStateStore({
    statePath,
    ...options,
    now: () => new Date("2026-07-12T12:00:00.000Z"),
  });
}

function fixturePath(name: string): string {
  return resolve(fixturesRoot, name);
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "sdi-state-load-"));
  temporaryDirectories.push(directory);
  return directory;
}
