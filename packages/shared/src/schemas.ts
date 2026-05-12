import { z } from "zod";

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  app: z.string(),
  version: z.string(),
  contentRoot: z.string(),
  databasePath: z.string(),
  git: z
    .object({
      branch: z.string(),
      commit: z.string(),
    })
    .nullable(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const pageTreeItemSchema = z.object({
  slug: z.string(),
  title: z.string(),
  path: z.string(),
});

export type PageTreeItem = z.infer<typeof pageTreeItemSchema>;

export const pageDocumentSchema = z.object({
  slug: z.string(),
  title: z.string(),
  body: z.string(),
  path: z.string(),
  meta: z.record(z.string(), z.unknown()),
});

export type PageDocument = z.infer<typeof pageDocumentSchema>;

export const pageMutationResponseSchema = z.object({
  ok: z.literal(true),
  slug: z.string(),
  hash: z.string().optional(),
  commit: z.string().nullable(),
});

export type PageMutationResponse = z.infer<typeof pageMutationResponseSchema>;

export const searchResultItemSchema = z.object({
  slug: z.string(),
  title: z.string(),
  path: z.string(),
  excerpt: z.string(),
});

export type SearchResultItem = z.infer<typeof searchResultItemSchema>;

export const pageHistoryItemSchema = z.object({
  commit: z.string(),
  author: z.string(),
  date: z.string(),
  message: z.string(),
});

export type PageHistoryItem = z.infer<typeof pageHistoryItemSchema>;

export const reindexResponseSchema = z.object({
  ok: z.literal(true),
  total: z.number().int().nonnegative(),
  indexed: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
});

export type ReindexResponse = z.infer<typeof reindexResponseSchema>;
