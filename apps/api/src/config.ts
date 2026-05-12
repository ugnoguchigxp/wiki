import path from "node:path";

const defaultContentRoot = "/Users/y.noguchi/Code/wiki-knowledge";
const rawPort = Number.parseInt(process.env.PORT ?? "8787", 10);
const port = Number.isFinite(rawPort) ? rawPort : 8787;

const contentRoot = path.resolve(process.env.CONTENT_ROOT ?? defaultContentRoot);
const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(contentRoot, ".wiki"));
const databasePath = path.resolve(process.env.DATABASE_PATH ?? path.join(dataDir, "wiki.sqlite"));

export const appConfig = {
  appName: "wiki-api",
  version: "0.1.0",
  port,
  contentRoot,
  dataDir,
  databasePath,
};
