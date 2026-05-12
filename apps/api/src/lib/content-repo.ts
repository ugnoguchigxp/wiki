import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import matter from "gray-matter";
import { assertSafeSlug, filePathToSlug } from "./slug.js";

const execFileAsync = promisify(execFile);

export type GitSummary = {
  branch: string;
  commit: string;
} | null;

export type PageTreeItem = {
  slug: string;
  title: string;
  path: string;
  updatedAt: Date;
};

export type PageDocument = {
  slug: string;
  title: string;
  body: string;
  path: string;
  meta: Record<string, unknown>;
};

const pagesDirectory = (contentRoot: string) => path.resolve(contentRoot, "pages");

const normalizePosixPath = (targetPath: string): string => targetPath.split(path.sep).join("/");

const isNotFoundError = (error: unknown): boolean => {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }
  return error.code === "ENOENT" || error.code === "ENOTDIR";
};

const assertInsidePages = (contentRoot: string, relativePath: string): string => {
  const pagesRoot = pagesDirectory(contentRoot);
  const safeRelative = relativePath.replace(/^\/+/, "");
  const absolute = path.resolve(pagesRoot, safeRelative);
  const isInside = absolute === pagesRoot || absolute.startsWith(`${pagesRoot}${path.sep}`);

  if (!isInside) {
    throw new Error("Invalid page path");
  }

  return absolute;
};

export const ensureContentRoot = async (contentRoot: string): Promise<void> => {
  const pagesRoot = pagesDirectory(contentRoot);
  await fs.mkdir(pagesRoot, { recursive: true });
  await fs.mkdir(path.resolve(contentRoot, ".wiki"), { recursive: true });
};

export const getGitSummary = async (contentRoot: string): Promise<GitSummary> => {
  try {
    const [{ stdout: branchStdout }, { stdout: commitStdout }] = await Promise.all([
      execFileAsync("git", ["-C", contentRoot, "rev-parse", "--abbrev-ref", "HEAD"]),
      execFileAsync("git", ["-C", contentRoot, "rev-parse", "--short", "HEAD"]),
    ]);

    return {
      branch: branchStdout.trim(),
      commit: commitStdout.trim(),
    };
  } catch {
    return null;
  }
};

const readMarkdownFiles = async (
  root: string,
): Promise<Array<{ filePath: string; updatedAt: Date }>> => {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const results: Array<{ filePath: string; updatedAt: Date }> = [];

  for (const entry of entries) {
    const fullPath = path.resolve(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await readMarkdownFiles(fullPath);
      results.push(...nested);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const stat = await fs.stat(fullPath);
      results.push({ filePath: fullPath, updatedAt: stat.mtime });
    }
  }
  return results;
};

export const listPages = async (contentRoot: string): Promise<PageTreeItem[]> => {
  const pagesRoot = pagesDirectory(contentRoot);
  const files = await readMarkdownFiles(pagesRoot);

  const items: PageTreeItem[] = files.map((file) => {
    const relativePath = path.relative(pagesRoot, file.filePath);
    const slug = filePathToSlug(relativePath);

    return {
      slug,
      title: slug || "Home", // Default to slug, will be updated during indexing
      path: normalizePosixPath(relativePath),
      updatedAt: file.updatedAt,
    };
  });

  return items.sort((a, b) => a.slug.localeCompare(b.slug));
};

export const resolveCandidateRelativePaths = (slug: string): string[] => {
  const safe = assertSafeSlug(slug);
  if (safe === "") {
    return ["index.md"];
  }
  return [`${safe}.md`, path.join(safe, "index.md")];
};

export const resolvePreferredRelativePath = (slug: string): string => {
  const safe = assertSafeSlug(slug);
  if (safe === "") {
    return "index.md";
  }
  return `${safe}.md`;
};

export const findExistingPageRelativePath = async (
  contentRoot: string,
  slug: string,
): Promise<string | null> => {
  const candidates = resolveCandidateRelativePaths(slug);

  for (const candidate of candidates) {
    const absolute = assertInsidePages(contentRoot, candidate);
    try {
      const stat = await fs.stat(absolute);
      if (stat.isFile()) {
        return normalizePosixPath(candidate);
      }
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }

  return null;
};

export const readPage = async (contentRoot: string, slug: string): Promise<PageDocument | null> => {
  const candidates = resolveCandidateRelativePaths(slug);

  for (const candidate of candidates) {
    const absolute = assertInsidePages(contentRoot, candidate);
    try {
      const raw = await fs.readFile(absolute, "utf8");
      const parsed = matter(raw);
      const relativePath = path.relative(pagesDirectory(contentRoot), absolute);
      const normalizedPath = normalizePosixPath(relativePath);
      const normalizedSlug = filePathToSlug(normalizedPath);
      const title =
        typeof parsed.data.title === "string" && parsed.data.title.length > 0
          ? parsed.data.title
          : normalizedSlug || "Home";

      return {
        slug: normalizedSlug,
        title,
        body: parsed.content,
        path: normalizedPath,
        meta: parsed.data as Record<string, unknown>,
      };
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }

  return null;
};

const serializeMarkdown = (title: string, body: string, meta: Record<string, unknown>): string => {
  const mergedMeta: Record<string, unknown> = {
    ...meta,
    title,
  };
  const compiled = matter.stringify(body.endsWith("\n") ? body : `${body}\n`, mergedMeta);
  return compiled;
};

const resolveWritePath = (contentRoot: string, slug: string): string => {
  const safe = assertSafeSlug(slug);
  const relative = safe === "" ? "index.md" : `${safe}.md`;
  return assertInsidePages(contentRoot, relative);
};

export const writePage = async (
  contentRoot: string,
  slug: string,
  title: string,
  body: string,
  meta: Record<string, unknown>,
): Promise<{ path: string; hash: string }> => {
  const targetPath = resolveWritePath(contentRoot, slug);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  const output = serializeMarkdown(title, body, meta);
  await fs.writeFile(targetPath, output, "utf8");

  return {
    path: targetPath,
    hash: crypto.createHash("sha256").update(output).digest("hex"),
  };
};

const removeEmptyParentDirectories = async (
  contentRoot: string,
  removedFilePath: string,
): Promise<void> => {
  const pagesRoot = pagesDirectory(contentRoot);
  let currentDir = path.dirname(removedFilePath);

  while (currentDir !== pagesRoot && currentDir.startsWith(`${pagesRoot}${path.sep}`)) {
    try {
      const entries = await fs.readdir(currentDir);
      if (entries.length > 0) {
        return;
      }
      await fs.rmdir(currentDir);
      currentDir = path.dirname(currentDir);
    } catch {
      return;
    }
  }
};

export const deletePage = async (contentRoot: string, slug: string): Promise<string> => {
  const candidates = resolveCandidateRelativePaths(slug).map((candidate) =>
    assertInsidePages(contentRoot, candidate),
  );

  for (const candidate of candidates) {
    try {
      await fs.rm(candidate);
      await removeEmptyParentDirectories(contentRoot, candidate);
      return candidate;
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }

  throw new Error("Page not found");
};

const runGit = async (
  contentRoot: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> =>
  execFileAsync("git", ["-C", contentRoot, ...args]);

const hasStagedChanges = async (contentRoot: string, relativePath: string): Promise<boolean> => {
  try {
    await runGit(contentRoot, ["diff", "--cached", "--quiet", "--", relativePath]);
    return false;
  } catch {
    return true;
  }
};

export const ensureGitRepo = async (contentRoot: string): Promise<void> => {
  const gitPath = path.resolve(contentRoot, ".git");
  try {
    await fs.access(gitPath);
  } catch {
    await runGit(contentRoot, ["init"]);
    await runGit(contentRoot, ["checkout", "-b", "main"]);
  }
};

export const commitFileChange = async (
  contentRoot: string,
  absolutePath: string,
  message: string,
): Promise<string | null> => {
  const relative = path.relative(contentRoot, absolutePath);
  const normalizedRelative = normalizePosixPath(relative);
  await runGit(contentRoot, ["add", normalizedRelative]);
  try {
    await runGit(contentRoot, ["commit", "-m", message]);
  } catch (error) {
    if (await hasStagedChanges(contentRoot, normalizedRelative)) {
      throw error;
    }
  }
  const summary = await getGitSummary(contentRoot);
  return summary?.commit ?? null;
};

export const commitDeleteChange = async (
  contentRoot: string,
  absolutePath: string,
  message: string,
): Promise<string | null> => {
  const relative = path.relative(contentRoot, absolutePath);
  const normalizedRelative = normalizePosixPath(relative);
  await runGit(contentRoot, ["add", "-A", normalizedRelative]);
  try {
    await runGit(contentRoot, ["commit", "-m", message]);
  } catch (error) {
    if (await hasStagedChanges(contentRoot, normalizedRelative)) {
      throw error;
    }
  }
  const summary = await getGitSummary(contentRoot);
  return summary?.commit ?? null;
};

const resolveGitPathspecs = async (contentRoot: string, slug: string): Promise<string[]> => {
  const existing = await findExistingPageRelativePath(contentRoot, slug);
  if (existing) {
    return [path.posix.join("pages", existing)];
  }

  return resolveCandidateRelativePaths(slug).map((candidate) =>
    path.posix.join("pages", normalizePosixPath(candidate)),
  );
};

export const getPageHistory = async (
  contentRoot: string,
  slug: string,
): Promise<
  Array<{
    commit: string;
    author: string;
    date: string;
    message: string;
  }>
> => {
  const pathspecs = await resolveGitPathspecs(contentRoot, slug);
  try {
    const { stdout } = await runGit(contentRoot, [
      "log",
      "--pretty=format:%H\t%an\t%ad\t%s",
      "--date=iso-strict",
      "--",
      ...pathspecs,
    ]);

    return stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const [commit, author, date, message] = line.split("\t");
        return {
          commit: commit ?? "",
          author: author ?? "",
          date: date ?? "",
          message: message ?? "",
        };
      });
  } catch {
    return [];
  }
};

export const getPageDiff = async (
  contentRoot: string,
  slug: string,
  from: string,
  to: string,
): Promise<string> => {
  const pathspecs = await resolveGitPathspecs(contentRoot, slug);
  try {
    const { stdout } = await runGit(contentRoot, ["diff", from, to, "--", ...pathspecs]);
    return stdout;
  } catch {
    return "";
  }
};
