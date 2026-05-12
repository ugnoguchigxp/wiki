import { existsSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { healthHandler } from "./routes/health.js";
import { registerPageRoutes } from "./routes/pages.js";

const findPublicRoot = (): string | null => {
  const candidates = ["public", join("apps", "api", "public")];
  return candidates.find((candidate) => existsSync(join(candidate, "index.html"))) ?? null;
};

export const createApp = () => {
  const app = new Hono();
  const publicRoot = findPublicRoot();

  app.use(
    "*",
    cors({
      origin: "*",
      allowHeaders: ["Content-Type"],
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    }),
  );

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
