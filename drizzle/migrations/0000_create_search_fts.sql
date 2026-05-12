-- Phase 0 placeholder for FTS5 virtual table.
-- This table is managed by raw SQL migration instead of drizzle schema bindings.
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(slug, title, body);
