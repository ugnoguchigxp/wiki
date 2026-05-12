import path from "node:path";
import { defineConfig } from "drizzle-kit";

const contentRoot = path.resolve(
  process.env.CONTENT_ROOT ?? "/Users/y.noguchi/Code/wiki-knowledge",
);
const databasePath = path.resolve(
  process.env.DATABASE_PATH ?? path.join(contentRoot, ".wiki", "wiki.sqlite"),
);

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "../../drizzle/migrations",
  tablesFilter: ["pages", "page_meta", "page_links"],
  dbCredentials: {
    url: databasePath,
  },
});
