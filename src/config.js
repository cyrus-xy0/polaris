import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function resolveDataRoot({ argv = [], env = {}, cwd = process.cwd(), fallback } = {}) {
  const cliDataDir = readDataDirArg(argv);
  const requestedDataDir = cliDataDir ?? env.POLARIS_DATA_DIR ?? fallback;
  if (!requestedDataDir) {
    throw new Error("A fallback data directory is required");
  }

  return resolve(cwd, requestedDataDir);
}

export function hasDataRootOverride({ argv = [], env = {} } = {}) {
  return Boolean(readDataDirArg(argv) ?? env.POLARIS_DATA_DIR);
}

export function shouldSeedDemoData({ argv = [], env = {} } = {}) {
  return argv.includes("--seed-demo") || isTruthyEnvValue(env.POLARIS_SEED_DEMO);
}

export function getDefaultDataRoot({ env = process.env, platform = process.platform, homeDir = homedir() } = {}) {
  const home = env.HOME || homeDir;

  if (platform === "darwin" && home) {
    return join(home, "Library", "Application Support", "Polaris");
  }
  if (platform === "win32" && env.APPDATA) {
    return join(env.APPDATA, "Polaris");
  }
  if (env.XDG_DATA_HOME) {
    return join(env.XDG_DATA_HOME, "polaris");
  }
  if (home) {
    return join(home, ".local", "share", "polaris");
  }

  return resolve(process.cwd(), ".polaris-data");
}

function isTruthyEnvValue(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

function readDataDirArg(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--data-dir") {
      if (!argv[index + 1] || argv[index + 1].startsWith("--")) {
        throw new Error("--data-dir requires a directory path");
      }
      return argv[index + 1];
    }
    if (value.startsWith("--data-dir=")) {
      return value.slice("--data-dir=".length);
    }
  }
  return null;
}
