import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import { appConfig } from "../config.js";
import { getDb } from "../db/client.js";
import { pages } from "../db/schema.js";
import {
  commitDeleteChange,
  commitFileChange,
  commitPathsChange,
  createFolder,
  deleteFolder,
  deletePage,
  getPageDiff,
  getPageHistory,
  listFolders,
  readPage,
  renameFolder,
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
  slug: pageSlugSchema.optional(),
  title: z.string().min(1).optional(),
  body: z.string(),
  meta: z.record(z.string(), z.unknown()).optional(),
  commitMessage: z.string().min(1).optional(),
});

const folderPathSchema = pageSlugSchema.refine((value) => value !== "", {
  message: "Invalid folder path",
});

const writeFolderSchema = z.object({
  path: folderPathSchema,
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

const invalidFolderResponse = (folderPath: string) => ({
  message: "Invalid folder path",
  path: folderPath,
});

const isInvalidFolderPath = (folderPath: string): boolean =>
  folderPath === "" || !isSafeSlug(folderPath);

const folderErrorStatus = (error: unknown): 400 | 404 | 409 => {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("already exists") || message.includes("conflicts")) {
    return 409;
  }
  if (message.includes("not found") || message.includes("ENOENT")) {
    return 404;
  }
  return 400;
};

export const registerPageRoutes = (app: Hono) => {
  app.get("/api/pages/tree", async (c) => {
    const db = await getDb();
    const [records, folders] = await Promise.all([
      db
        .select({
          slug: pages.slug,
          title: pages.title,
          path: pages.path,
          updatedAt: pages.updatedAt,
        })
        .from(pages)
        .orderBy(pages.slug),
      listFolders(appConfig.contentRoot),
    ]);

    return c.json({ items: records, folders });
  });

  app.get("/api/folders", async (c) => {
    const folders = await listFolders(appConfig.contentRoot);
    return c.json({ items: folders });
  });

  app.post("/api/folders", zValidator("json", writeFolderSchema), async (c) => {
    const payload = c.req.valid("json");

    try {
      const created = await createFolder(appConfig.contentRoot, payload.path);
      const commit = await commitFileChange(
        appConfig.contentRoot,
        created.keepFilePath,
        `docs(folder): create ${created.path}`,
      );

      return c.json({
        ok: true,
        path: created.path,
        commit,
      });
    } catch (error) {
      return c.json(
        {
          message: error instanceof Error ? error.message : "Folder create failed",
          path: payload.path,
        },
        folderErrorStatus(error),
      );
    }
  });

  app.put("/api/folders/*", zValidator("json", writeFolderSchema), async (c) => {
    const folderPath = slugFromRequestPath(c.req.url, "/api/folders/");
    if (isInvalidFolderPath(folderPath)) {
      return c.json(invalidFolderResponse(folderPath), 400);
    }

    const payload = c.req.valid("json");
    try {
      const renamed = await renameFolder(appConfig.contentRoot, folderPath, payload.path);
      const commit = await commitPathsChange(
        appConfig.contentRoot,
        [renamed.oldAbsolutePath, renamed.newAbsolutePath],
        `docs(folder): rename ${renamed.from} to ${renamed.path}`,
      );
      const db = await getDb();
      const reindex = await reindexAllPages(db, appConfig.contentRoot);

      return c.json({
        ok: true,
        from: renamed.from,
        path: renamed.path,
        movedPages: renamed.movedPages,
        commit,
        reindex,
      });
    } catch (error) {
      return c.json(
        {
          message: error instanceof Error ? error.message : "Folder rename failed",
          path: folderPath,
        },
        folderErrorStatus(error),
      );
    }
  });

  app.delete("/api/folders/*", async (c) => {
    const folderPath = slugFromRequestPath(c.req.url, "/api/folders/");
    if (isInvalidFolderPath(folderPath)) {
      return c.json(invalidFolderResponse(folderPath), 400);
    }

    try {
      const deleted = await deleteFolder(appConfig.contentRoot, folderPath);
      const commit = await commitPathsChange(
        appConfig.contentRoot,
        [deleted.absolutePath],
        `docs(folder): delete ${deleted.path}`,
      );
      const db = await getDb();
      const reindex = await reindexAllPages(db, appConfig.contentRoot);

      return c.json({
        ok: true,
        path: deleted.path,
        deletedSlugs: deleted.deletedSlugs,
        commit,
        reindex,
      });
    } catch (error) {
      return c.json(
        {
          message: error instanceof Error ? error.message : "Folder delete failed",
          path: folderPath,
        },
        folderErrorStatus(error),
      );
    }
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
    const targetSlug = payload.slug ?? slug;
    if (targetSlug !== slug) {
      const targetExisting = await readPage(appConfig.contentRoot, targetSlug);
      if (targetExisting) {
        return c.json({ message: "Page already exists", slug: targetSlug }, 409);
      }
    }

    const title = payload.title ?? existing.title;
    const meta = payload.meta ?? existing.meta;
    const { path, hash } = await writePage(
      appConfig.contentRoot,
      targetSlug,
      title,
      payload.body,
      meta,
      targetSlug === slug ? { relativePath: existing.path } : undefined,
    );

    let commit: string | null;
    if (targetSlug === slug) {
      commit = await commitFileChange(
        appConfig.contentRoot,
        path,
        payload.commitMessage ?? `docs(page): update ${slug || "home"}`,
      );
    } else {
      const deletedPath = await deletePage(appConfig.contentRoot, slug);
      commit = await commitPathsChange(
        appConfig.contentRoot,
        [path, deletedPath],
        payload.commitMessage ?? `docs(page): rename ${slug || "home"} to ${targetSlug || "home"}`,
      );
    }

    const savedPage = await readPage(appConfig.contentRoot, targetSlug);
    if (!savedPage) {
      return c.json({ message: "Page save verification failed", slug: targetSlug }, 500);
    }

    const db = await getDb();
    if (targetSlug !== slug) {
      await removePageIndex(db, slug);
    }
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
