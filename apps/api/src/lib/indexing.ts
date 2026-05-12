import crypto from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { pageLinks, pageMeta, pages } from "../db/schema.js";
import { getGitSummary, listPages, type PageDocument, readPage } from "./content-repo.js";
import { sanitizeSlug } from "./slug.js";

type NormalizedMeta = {
  showOnMenu: boolean;
  showOnHome: boolean;
  sort: number;
  tags: string[];
};

export type SearchResultItem = {
  slug: string;
  title: string;
  path: string;
  excerpt: string;
};

export type ReindexResult = {
  total: number;
  indexed: number;
  removed: number;
};

const ensureFtsTable = async (db: DbClient): Promise<void> => {
  await db.run(
    sql`CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(slug, title, body, tokenize = 'unicode61')`,
  );
};

const extractWikiLinks = (body: string): string[] => {
  const found = new Set<string>();
  const pattern = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;

  let match = pattern.exec(body);
  while (match) {
    const raw = (match[1] ?? "").trim();
    if (raw && !raw.includes("://")) {
      const normalized = sanitizeSlug(raw.replace(/\.md$/i, ""));
      if (normalized !== "") {
        found.add(normalized);
      }
    }
    match = pattern.exec(body);
  }

  return [...found];
};

const parseBoolean = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
};

const parseSort = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
};

const parseTags = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry).trim())
      .filter((entry) => entry.length > 0)
      .slice(0, 50);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .slice(0, 50);
  }
  return [];
};

const normalizeMeta = (meta: Record<string, unknown>): NormalizedMeta => {
  return {
    showOnMenu: parseBoolean(meta.showOnMenu, true),
    showOnHome: parseBoolean(meta.showOnHome, true),
    sort: parseSort(meta.sort),
    tags: parseTags(meta.tags),
  };
};

const computePageHash = (page: PageDocument): string =>
  crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        title: page.title,
        body: page.body,
        meta: page.meta,
        path: page.path,
      }),
    )
    .digest("hex");

export const removePageIndex = async (db: DbClient, slug: string): Promise<void> => {
  await ensureFtsTable(db);

  await db.delete(pageLinks).where(eq(pageLinks.fromSlug, slug));
  await db.delete(pageLinks).where(eq(pageLinks.toSlug, slug));
  await db.delete(pageMeta).where(eq(pageMeta.slug, slug));
  await db.delete(pages).where(eq(pages.slug, slug));
  await db.run(sql`DELETE FROM search_fts WHERE slug = ${slug}`);
};

export const upsertPageIndex = async (
  db: DbClient,
  page: PageDocument,
  lastCommit: string | null,
  contentHash?: string,
  mtime?: Date,
): Promise<void> => {
  await ensureFtsTable(db);

  const hash = contentHash ?? computePageHash(page);
  const meta = normalizeMeta(page.meta);
  const pageLinksList = extractWikiLinks(page.body);
  const updatedAt = mtime ?? new Date();

  await db
    .insert(pages)
    .values({
      id: page.slug,
      slug: page.slug,
      title: page.title,
      path: page.path,
      contentHash: hash,
      updatedAt: updatedAt,
      lastCommit,
    })
    .onConflictDoUpdate({
      target: pages.slug,
      set: {
        title: page.title,
        path: page.path,
        contentHash: hash,
        updatedAt: updatedAt,
        lastCommit,
      },
    });

  await db
    .insert(pageMeta)
    .values({
      slug: page.slug,
      showOnMenu: meta.showOnMenu,
      showOnHome: meta.showOnHome,
      sort: meta.sort,
      tags: meta.tags.length > 0 ? JSON.stringify(meta.tags) : null,
    })
    .onConflictDoUpdate({
      target: pageMeta.slug,
      set: {
        showOnMenu: meta.showOnMenu,
        showOnHome: meta.showOnHome,
        sort: meta.sort,
        tags: meta.tags.length > 0 ? JSON.stringify(meta.tags) : null,
      },
    });

  await db.delete(pageLinks).where(eq(pageLinks.fromSlug, page.slug));
  if (pageLinksList.length > 0) {
    await db.insert(pageLinks).values(
      pageLinksList.map((link) => ({
        fromSlug: page.slug,
        toSlug: link,
      })),
    );
  }

  await db.run(sql`DELETE FROM search_fts WHERE slug = ${page.slug}`);
  await db.run(
    sql`INSERT INTO search_fts (slug, title, body) VALUES (${page.slug}, ${page.title}, ${page.body})`,
  );
};

const buildFtsQuery = (query: string): string => {
  const tokens = query
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => token.replace(/[^\p{L}\p{N}_-]/gu, ""))
    .filter((token) => token.length > 0)
    .slice(0, 8);

  if (tokens.length === 0) {
    return "";
  }

  return tokens.map((token) => `${token}*`).join(" AND ");
};

export const searchPages = async (db: DbClient, query: string): Promise<SearchResultItem[]> => {
  await ensureFtsTable(db);

  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) {
    return [];
  }

  try {
    const rows = await db.all<{
      slug: string;
      title: string;
      path: string | null;
      excerpt: string | null;
    }>(
      sql`SELECT
            search_fts.slug AS slug,
            COALESCE(pages.title, search_fts.title) AS title,
            pages.path AS path,
            snippet(search_fts, 2, '', '', ' … ', 20) AS excerpt
          FROM search_fts
          LEFT JOIN pages ON pages.slug = search_fts.slug
          WHERE search_fts MATCH ${ftsQuery}
          ORDER BY bm25(search_fts)
          LIMIT 50`,
    );

    return rows.map((row) => ({
      slug: row.slug,
      title: row.title,
      path: row.path ?? `${row.slug || "index"}.md`,
      excerpt: row.excerpt?.trim() || "(no preview)",
    }));
  } catch {
    return [];
  }
};

export const reindexAllPages = async (
  db: DbClient,
  contentRoot: string,
): Promise<ReindexResult> => {
  await ensureFtsTable(db);

  const listed = await listPages(contentRoot);
  const gitSummary = await getGitSummary(contentRoot);
  const currentSlugs = new Set<string>(listed.map((item) => item.slug));

  const existingRecords = await db
    .select({ slug: pages.slug, updatedAt: pages.updatedAt })
    .from(pages);

  const tasks = listed.map(async (item) => {
    const page = await readPage(contentRoot, item.slug);
    if (!page) {
      return false;
    }

    await upsertPageIndex(db, page, gitSummary?.commit ?? null, undefined, item.updatedAt);
    return true;
  });

  const results = await Promise.all(tasks);
  const indexed = results.filter(Boolean).length;

  const staleSlugs = existingRecords
    .map((row) => row.slug)
    .filter((slug) => !currentSlugs.has(slug));

  if (staleSlugs.length > 0) {
    await db.delete(pageLinks).where(inArray(pageLinks.fromSlug, staleSlugs));
    await db.delete(pageLinks).where(inArray(pageLinks.toSlug, staleSlugs));
    await db.delete(pageMeta).where(inArray(pageMeta.slug, staleSlugs));
    await db.delete(pages).where(inArray(pages.slug, staleSlugs));
    for (const slug of staleSlugs) {
      await db.run(sql`DELETE FROM search_fts WHERE slug = ${slug}`);
    }
  }

  return {
    total: listed.length,
    indexed,
    removed: staleSlugs.length,
  };
};
