import { resolve } from "node:path";

export function resolveDataRoot({ argv = [], env = {}, cwd = process.cwd(), fallback } = {}) {
  const cliDataDir = readDataDirArg(argv);
  const requestedDataDir = cliDataDir ?? env.NORTHSTAR_DATA_DIR ?? fallback;
  if (!requestedDataDir) {
    throw new Error("A fallback data directory is required");
  }

  return resolve(cwd, requestedDataDir);
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
