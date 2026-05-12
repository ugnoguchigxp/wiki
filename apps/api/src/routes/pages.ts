import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import { appConfig } from "../config.js";
import { getDb } from "../db/client.js";
import {
  commitDeleteChange,
  commitFileChange,
  deletePage,
  getPageDiff,
  getPageHistory,
  listPages,
  readPage,
  writePage,
} from "../lib/content-repo.js";
import { reindexAllPages, removePageIndex, searchPages, upsertPageIndex } from "../lib/indexing.js";
import { extractRemainderFromPathname, isSafeSlug, sanitizeSlug } from "../lib/slug.js";

const pageSlugSchema = z
  .string()
  .transform((value) => sanitizeSlug(value))
  .refine((value) => isSafeSlug(value), {
    message: "Invalid page slug",
  });

const writePageSchema = z.object({
  slug: pageSlugSchema,
  title: z.string().min(1),
  body: z.string(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const updatePageSchema = z.object({
  title: z.string().min(1).optional(),
  body: z.string(),
  meta: z.record(z.string(), z.unknown()).optional(),
  commitMessage: z.string().min(1).optional(),
});

const searchQuerySchema = z.object({
  q: z.string().optional(),
});

const diffQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

const slugFromRequestPath = (url: string, prefix: string): string => {
  const pathname = new URL(url).pathname;
  return sanitizeSlug(extractRemainderFromPathname(pathname, prefix));
};

const invalidSlugResponse = (slug: string) => ({
  message: "Invalid page slug",
  slug,
});

const isInvalidSlug = (slug: string): boolean => !isSafeSlug(slug);

export const registerPageRoutes = (app: Hono) => {
  app.get("/api/pages/tree", async (c) => {
    const pages = await listPages(appConfig.contentRoot);
    return c.json({ items: pages });
  });

  app.get("/api/pages/*", async (c) => {
    const slug = slugFromRequestPath(c.req.url, "/api/pages/");
    if (isInvalidSlug(slug)) {
      return c.json(invalidSlugResponse(slug), 400);
    }

    const page = await readPage(appConfig.contentRoot, slug);
    if (!page) {
      return c.json({ message: "Page not found", slug }, 404);
    }
    return c.json(page);
  });

  app.post("/api/pages", zValidator("json", writePageSchema), async (c) => {
    const payload = c.req.valid("json");
    const meta = payload.meta ?? {};
    const existing = await readPage(appConfig.contentRoot, payload.slug);
    if (existing) {
      return c.json({ message: "Page already exists", slug: payload.slug }, 409);
    }

    const { path, hash } = await writePage(
      appConfig.contentRoot,
      payload.slug,
      payload.title,
      payload.body,
      meta,
    );
    const commit = await commitFileChange(
      appConfig.contentRoot,
      path,
      `docs(page): create ${payload.slug || "home"}`,
    );

    const savedPage = await readPage(appConfig.contentRoot, payload.slug);
    if (!savedPage) {
      return c.json({ message: "Page save verification failed" }, 500);
    }

    const db = await getDb();
    await upsertPageIndex(db, savedPage, commit, hash);

    return c.json({
      ok: true,
      slug: savedPage.slug,
      hash,
      commit,
    });
  });

  app.put("/api/pages/*", zValidator("json", updatePageSchema), async (c) => {
    const slug = slugFromRequestPath(c.req.url, "/api/pages/");
    if (isInvalidSlug(slug)) {
      return c.json(invalidSlugResponse(slug), 400);
    }

    const existing = await readPage(appConfig.contentRoot, slug);
    if (!existing) {
      return c.json({ message: "Page not found", slug }, 404);
    }

    const payload = c.req.valid("json");
    const title = payload.title ?? existing.title;
    const meta = payload.meta ?? existing.meta;
    const { path, hash } = await writePage(appConfig.contentRoot, slug, title, payload.body, meta);
    const commit = await commitFileChange(
      appConfig.contentRoot,
      path,
      payload.commitMessage ?? `docs(page): update ${slug || "home"}`,
    );

    const savedPage = await readPage(appConfig.contentRoot, slug);
    if (!savedPage) {
      return c.json({ message: "Page save verification failed", slug }, 500);
    }

    const db = await getDb();
    await upsertPageIndex(db, savedPage, commit, hash);

    return c.json({
      ok: true,
      slug: savedPage.slug,
      hash,
      commit,
    });
  });

  app.delete("/api/pages/*", async (c) => {
    const slug = slugFromRequestPath(c.req.url, "/api/pages/");
    if (isInvalidSlug(slug)) {
      return c.json(invalidSlugResponse(slug), 400);
    }

    try {
      const deletedPath = await deletePage(appConfig.contentRoot, slug);
      const commit = await commitDeleteChange(
        appConfig.contentRoot,
        deletedPath,
        `docs(page): delete ${slug || "home"}`,
      );

      const db = await getDb();
      await removePageIndex(db, slug);

      return c.json({
        ok: true,
        slug,
        commit,
      });
    } catch {
      return c.json({ message: "Page not found", slug }, 404);
    }
  });

  app.get("/api/search", zValidator("query", searchQuerySchema), async (c) => {
    const { q } = c.req.valid("query");
    if (!q || q.trim() === "") {
      return c.json({ items: [] });
    }

    const db = await getDb();
    const items = await searchPages(db, q);
    return c.json({ items });
  });

  app.get("/api/history/*", async (c) => {
    const slug = slugFromRequestPath(c.req.url, "/api/history/");
    if (isInvalidSlug(slug)) {
      return c.json(invalidSlugResponse(slug), 400);
    }

    const items = await getPageHistory(appConfig.contentRoot, slug);
    return c.json({ slug, items });
  });

  app.get("/api/diff/*", zValidator("query", diffQuerySchema), async (c) => {
    const slug = slugFromRequestPath(c.req.url, "/api/diff/");
    if (isInvalidSlug(slug)) {
      return c.json(invalidSlugResponse(slug), 400);
    }

    const { from, to } = c.req.valid("query");
    if (!from || !to) {
      return c.json({ message: "from and to query are required" }, 400);
    }
    const diff = await getPageDiff(appConfig.contentRoot, slug, from, to);
    return c.json({ slug, from, to, diff });
  });

  app.post("/api/reindex", async (c) => {
    const db = await getDb();
    const result = await reindexAllPages(db, appConfig.contentRoot);
    return c.json({
      ok: true,
      ...result,
    });
  });
};
