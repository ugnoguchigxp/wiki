import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { appConfig } from "../config.js";
import * as schema from "./schema.js";

export type DbClient = BetterSQLite3Database<typeof schema>;

let connection: Database.Database | null = null;
let client: DbClient | null = null;
let connectionPath: string | null = null;

const ensureCoreSchema = (db: Database.Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      content_hash TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      last_commit TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS page_meta (
      slug TEXT PRIMARY KEY NOT NULL,
      show_on_menu INTEGER NOT NULL DEFAULT 1,
      show_on_home INTEGER NOT NULL DEFAULT 1,
      sort INTEGER NOT NULL DEFAULT 0,
      tags TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS page_links (
      from_slug TEXT NOT NULL,
      to_slug TEXT NOT NULL,
      PRIMARY KEY (from_slug, to_slug)
    );
  `);
};

const createConnection = async (databasePath: string): Promise<DbClient> => {
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  connection = new Database(databasePath);
  connection.pragma("journal_mode = WAL");
  connection.pragma("foreign_keys = ON");
  ensureCoreSchema(connection);
  connectionPath = databasePath;
  client = drizzle(connection, { schema });
  return client;
};

export const closeDb = () => {
  if (connection) {
    connection.close();
  }
  connection = null;
  client = null;
  connectionPath = null;
};

export const getDb = async (): Promise<DbClient> => {
  const targetPath = appConfig.databasePath;

  if (client && connection && connectionPath === targetPath) {
    return client;
  }

  if (connection && connectionPath && connectionPath !== targetPath) {
    closeDb();
  }

  return createConnection(targetPath);
};

export const getSqliteConnection = async (): Promise<Database.Database> => {
  await getDb();
  if (!connection) {
    throw new Error("Database connection is not initialized");
  }
  return connection;
};
