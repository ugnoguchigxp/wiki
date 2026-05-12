import type { Context } from "hono";
import { appConfig } from "../config.js";
import { getGitSummary } from "../lib/content-repo.js";

export const healthHandler = async (c: Context) => {
  const git = await getGitSummary(appConfig.contentRoot);
  const payload = {
    ok: true,
    app: appConfig.appName,
    version: appConfig.version,
    contentRoot: appConfig.contentRoot,
    databasePath: appConfig.databasePath,
    git,
  };
  return c.json(payload);
};
