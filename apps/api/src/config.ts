import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiPackageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(apiPackageRoot, "../..");
const initialEnvKeys = new Set(Object.keys(process.env));

const readEnvFile = (filePath: string, options?: { overrideFileValues?: boolean }): void => {
  if (!existsSync(filePath)) {
    return;
  }

  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^(['"])(.*)\1$/, "$2");
    if (initialEnvKeys.has(key)) {
      continue;
    }
    if (options?.overrideFileValues || process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
};

readEnvFile(path.join(repoRoot, ".env"));
readEnvFile(path.join(repoRoot, ".env.local"), { overrideFileValues: true });

const resolveRepoPath = (value: string): string => {
  if (path.isAbsolute(value)) {
    return path.resolve(value);
  }
  return path.resolve(repoRoot, value);
};

const defaultContentRoot = "wiki-knowledge";
const rawPort = Number.parseInt(process.env.PORT ?? "8787", 10);
const port = Number.isFinite(rawPort) ? rawPort : 8787;

const contentRoot = resolveRepoPath(process.env.CONTENT_ROOT ?? defaultContentRoot);
const dataDir = process.env.DATA_DIR
  ? resolveRepoPath(process.env.DATA_DIR)
  : path.join(contentRoot, ".wiki");
const databasePath = process.env.DATABASE_PATH
  ? resolveRepoPath(process.env.DATABASE_PATH)
  : path.join(dataDir, "wiki.sqlite");

export const appConfig = {
  appName: "wiki-api",
  version: "0.1.0",
  repoRoot,
  port,
  contentRoot,
  dataDir,
  databasePath,
};
