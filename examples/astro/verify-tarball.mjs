import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const exampleDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(exampleDirectory, "../..");
const consumerTemplate = join(exampleDirectory, "consumer");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "sdi-tarball-consumer-"));
const packDirectory = join(temporaryDirectory, "pack");
const consumerDirectory = join(temporaryDirectory, "consumer");
const blocker = join(exampleDirectory, "network-blocker.cjs");
const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const npxCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");

try {
  await mkdir(packDirectory);
  const packed = JSON.parse(runNpm(["pack", "--json", "--pack-destination", packDirectory], repositoryDirectory));
  const tarball = join(packDirectory, packed[0].filename);

  assertTarballContents(packed[0]);
  await cp(consumerTemplate, consumerDirectory, { recursive: true });
  runNpm(["install", "--ignore-scripts", "--no-package-lock", "--no-save", tarball], consumerDirectory);

  const commandEnvironment = {
    ...process.env,
    NODE_OPTIONS: appendNodeOption(process.env.NODE_OPTIONS, `--require=${blocker}`),
    npm_config_offline: "true",
  };

  runNpx(["sdi", "--help"], consumerDirectory, commandEnvironment);
  runNpx(["sdi", "--version"], consumerDirectory, commandEnvironment);
  runNpx(["sdi", "baseline", "--confirm"], consumerDirectory, commandEnvironment);
  const stateAfterBaseline = await readFile(join(consumerDirectory, ".sdi", "state.json"), "utf8");
  const firstDryRun = runNpx(["sdi", "run", "--dry-run"], consumerDirectory, commandEnvironment);
  const secondDryRun = runNpx(["sdi", "run", "--dry-run"], consumerDirectory, commandEnvironment);

  assertIncludes(firstDryRun, "Changes: created=0 updated=0 unchanged=2 deleted=0", "first dry-run inventory");
  assertIncludes(secondDryRun, "Changes: created=0 updated=0 unchanged=2 deleted=0", "second dry-run inventory");
  assertEqual(await readFile(join(consumerDirectory, ".sdi", "state.json"), "utf8"), stateAfterBaseline, "dry-run must not modify state");
  await assertConsumerIsolation(consumerDirectory);
  console.log(`External tarball consumer validated in ${temporaryDirectory}`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function runNpm(args, cwd, env = process.env) {
  return run(process.platform === "win32" ? process.execPath : "npm", process.platform === "win32" ? [npmCli, ...args] : args, cwd, env);
}

function runNpx(args, cwd, env = process.env) {
  return run(process.platform === "win32" ? process.execPath : "npx", process.platform === "win32" ? [npxCli, ...args] : args, cwd, env);
}

function run(command, args, cwd, env = process.env) {
  return execFileSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function assertTarballContents(pack) {
  const expectedRoots = new Set(["README.md", "package.json"]);

  for (const file of pack.files) {
    if (!expectedRoots.has(file.path) && !file.path.startsWith("dist/")) {
      throw new Error(`Unexpected tarball file: ${file.path}`);
    }
  }

  if (pack.files.some((file) => /(^|\/)(src|tests|examples|node_modules|\.sdi)(\/|$)/.test(file.path))) {
    throw new Error("Tarball contains source, fixtures, state, or dependencies outside dist.");
  }
}

async function assertConsumerIsolation(consumerDirectory) {
  const installedPackage = join(consumerDirectory, "node_modules", "@sdi", "cli");
  const report = JSON.parse(await readFile(join(consumerDirectory, ".sdi", "last-run.json"), "utf8"));

  if (await exists(join(installedPackage, "src"))) {
    throw new Error("Installed package must not contain src/.");
  }

  for (const path of [report.config.statePath, report.config.reportPath, report.config.source.distDir, report.config.source.sitemapPath]) {
    if (!isWithin(consumerDirectory, path)) {
      throw new Error(`Consumer path resolved outside its own directory: ${path}`);
    }
  }

  for (const file of await filesUnder(join(installedPackage, "dist"))) {
    if (file.endsWith(".js") && /(?:from|import)\s*["'][^"']*(?:^|\/)src(?:\/|["'])/.test(await readFile(file, "utf8"))) {
      throw new Error(`Installed JavaScript imports src/: ${file}`);
    }
  }
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...await filesUnder(path));
    } else if ((await stat(path)).isFile()) {
      results.push(path);
    }
  }

  return results;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isWithin(directory, path) {
  const relativePath = relative(directory, path);
  return relativePath !== "" && !relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !relativePath.startsWith(".." + "/");
}

function appendNodeOption(current, option) {
  return current === undefined || current === "" ? option : `${current} ${option}`;
}

function assertIncludes(value, expected, label) {
  if (!value.includes(expected)) {
    throw new Error(`${label} did not contain '${expected}': ${value}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(label);
  }
}
