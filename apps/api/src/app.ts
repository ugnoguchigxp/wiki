import { existsSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { appConfig } from "./config.js";
import { getDb } from "./db/client.js";
import { ensureContentRoot, ensureGitRepo } from "./lib/content-repo.js";
import { reindexAllPages } from "./lib/indexing.js";
import {
  localApiWriteGuardMiddleware,
  resolveCorsOrigin,
  securityHeadersMiddleware,
  wikiRequestHeader,
} from "./lib/security.js";
import { healthHandler } from "./routes/health.js";
import { registerPageRoutes } from "./routes/pages.js";

const findPublicRoot = (): string | null => {
  const candidates = ["public", join("apps", "api", "public")];
  return candidates.find((candidate) => existsSync(join(candidate, "index.html"))) ?? null;
};

type CreateAppOptions = {
  runSetup?: boolean;
};

export const createApp = (options: CreateAppOptions = {}) => {
  const app = new Hono();
  const publicRoot = findPublicRoot();
  const shouldRunSetup =
    options.runSetup ?? (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true");

  // Dev-server imports cannot await module setup, so route handling waits on this promise.
  const setup = async () => {
    try {
      await ensureContentRoot(appConfig.contentRoot);
      await ensureGitRepo(appConfig.contentRoot);
      const db = await getDb();
      await reindexAllPages(db, appConfig.contentRoot);
    } catch (error) {
      console.error("API setup failed:", error);
    }
  };
  const setupPromise = shouldRunSetup ? setup() : Promise.resolve();

  app.use("*", securityHeadersMiddleware);
  app.use("*", async (_c, next) => {
    await setupPromise;
    await next();
  });
  app.use(
    "*",
    cors({
      origin: (origin) => resolveCorsOrigin(origin) ?? "",
      allowHeaders: ["Content-Type", wikiRequestHeader],
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    }),
  );
  app.use("/api/*", localApiWriteGuardMiddleware);

  app.get("/api/health", healthHandler);
  registerPageRoutes(app);

  app.all("/api/*", (c) => c.json({ message: "Not Found" }, 404));

  if (publicRoot) {
    app.use("*", serveStatic({ root: publicRoot }));
    app.get("*", serveStatic({ root: publicRoot, path: "index.html" }));
  } else {
    app.get("/", (c) => c.json({ ok: true, app: "wiki-api" }));
  }

  app.notFound((c) => c.json({ message: "Not Found" }, 404));

  return app;
};

export default createApp({ runSetup: false });
