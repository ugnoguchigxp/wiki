import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const pages = sqliteTable("pages", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  path: text("path").notNull().unique(),
  contentHash: text("content_hash").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  lastCommit: text("last_commit"),
});

export const pageMeta = sqliteTable("page_meta", {
  slug: text("slug").primaryKey(),
  showOnMenu: integer("show_on_menu", { mode: "boolean" }).notNull().default(true),
  showOnHome: integer("show_on_home", { mode: "boolean" }).notNull().default(true),
  sort: integer("sort").notNull().default(0),
  tags: text("tags"),
});

export const pageLinks = sqliteTable(
  "page_links",
  {
    fromSlug: text("from_slug").notNull(),
    toSlug: text("to_slug").notNull(),
  },
  (table) => [primaryKey({ columns: [table.fromSlug, table.toSlug] })],
);
