import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { appConfig } from "./config.js";
import { getDb } from "./db/client.js";
import { ensureContentRoot, ensureGitRepo } from "./lib/content-repo.js";
import { reindexAllPages } from "./lib/indexing.js";

const bootstrap = async () => {
  await ensureContentRoot(appConfig.contentRoot);
  await ensureGitRepo(appConfig.contentRoot);

  const db = await getDb();
  try {
    const result = await reindexAllPages(db, appConfig.contentRoot);
    console.log(
      `wiki-api index bootstrap complete (indexed=${result.indexed}, removed=${result.removed})`,
    );
  } catch (error) {
    console.error("wiki-api index bootstrap failed", error);
  }

  const app = createApp({ runSetup: false });
  serve(
    {
      fetch: app.fetch,
      port: appConfig.port,
      hostname: "127.0.0.1",
    },
    (info) => {
      console.log(
        `wiki-api listening on http://127.0.0.1:${info.port} (localhost only; not exposed to LAN)`,
      );
    },
  );
};

void bootstrap();
