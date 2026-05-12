import { appConfig } from "../config.js";
import { getDb } from "../db/client.js";
import { ensureContentRoot, ensureGitRepo } from "../lib/content-repo.js";
import { reindexAllPages } from "../lib/indexing.js";

const main = async () => {
  await ensureContentRoot(appConfig.contentRoot);
  await ensureGitRepo(appConfig.contentRoot);

  const db = await getDb();
  const result = await reindexAllPages(db, appConfig.contentRoot);

  console.log(
    JSON.stringify(
      {
        ok: true,
        contentRoot: appConfig.contentRoot,
        databasePath: appConfig.databasePath,
        ...result,
      },
      null,
      2,
    ),
  );
};

void main();
