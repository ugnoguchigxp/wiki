import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { appConfig } from "./config.js";
import { closeDb } from "./db/client.js";
import { ensureContentRoot, ensureGitRepo } from "./lib/content-repo.js";

const execFileAsync = promisify(execFile);
const jsonWriteHeaders = {
  "Content-Type": "application/json",
  "X-Wiki-Request": "local",
};
const writeHeaders = {
  "X-Wiki-Request": "local",
};

describe("api", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-api-"));

    appConfig.contentRoot = tempRoot;
    appConfig.dataDir = path.join(tempRoot, ".wiki");
    appConfig.databasePath = path.join(appConfig.dataDir, "wiki.sqlite");

    closeDb();

    await ensureContentRoot(tempRoot);
    await ensureGitRepo(tempRoot);

    await execFileAsync("git", ["-C", tempRoot, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", tempRoot, "config", "user.name", "Wiki Tester"]);
  });

  afterEach(async () => {
    closeDb();
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns health payload", async () => {
    const app = createApp();
    const res = await app.request("http://localhost/api/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.contentRoot).toBe(tempRoot);
  });

  it("enforces local origin and write request header", async () => {
    const app = createApp();

    const remoteOriginRes = await app.request("http://localhost/api/health", {
      headers: {
        Origin: "https://example.com",
      },
    });
    expect(remoteOriginRes.status).toBe(403);

    const localOriginRes = await app.request("http://localhost/api/health", {
      headers: {
        Origin: "http://localhost:8787",
      },
    });
    expect(localOriginRes.status).toBe(200);

    const missingHeaderRes = await app.request("http://localhost/api/pages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        slug: "blocked",
        title: "Blocked",
        body: "blocked",
      }),
    });
    expect(missingHeaderRes.status).toBe(403);
  });

  it("supports page CRUD, search, history and diff", async () => {
    const app = createApp();

    const createRes = await app.request("http://localhost/api/pages", {
      method: "POST",
      headers: jsonWriteHeaders,
      body: JSON.stringify({
        slug: "engineering/onboarding",
        title: "Engineering Onboarding",
        body: "Welcome to the team.\n\nUse runbook checklist.",
        meta: {
          showOnMenu: true,
          sort: 10,
          tags: ["engineering", "onboarding"],
        },
      }),
    });

    expect(createRes.status).toBe(200);
    const createBody = await createRes.json();
    expect(createBody.ok).toBe(true);
    expect(createBody.commit).toBeTruthy();

    const updateRes = await app.request("http://localhost/api/pages/engineering/onboarding", {
      method: "PUT",
      headers: jsonWriteHeaders,
      body: JSON.stringify({
        title: "Engineering Onboarding",
        body: "Welcome to the team.\n\nDeployment checklist for release.",
        meta: {
          showOnMenu: true,
          sort: 5,
          tags: ["engineering", "release"],
        },
        commitMessage: "docs(page): update onboarding release checklist",
      }),
    });

    expect(updateRes.status).toBe(200);
    const updateBody = await updateRes.json();
    expect(updateBody.ok).toBe(true);
    expect(updateBody.commit).toBeTruthy();

    const treeRes = await app.request("http://localhost/api/pages/tree");
    expect(treeRes.status).toBe(200);
    const treeBody = await treeRes.json();
    expect(
      treeBody.items.some((item: { slug: string }) => item.slug === "engineering/onboarding"),
    ).toBe(true);

    const pageRes = await app.request("http://localhost/api/pages/engineering/onboarding");
    expect(pageRes.status).toBe(200);
    const pageBody = await pageRes.json();
    expect(pageBody.title).toBe("Engineering Onboarding");
    expect(pageBody.body).toContain("Deployment checklist");

    const reindexRes = await app.request("http://localhost/api/reindex", {
      method: "POST",
      headers: writeHeaders,
    });
    expect(reindexRes.status).toBe(200);

    const searchRes = await app.request("http://localhost/api/search?q=deployment");
    expect(searchRes.status).toBe(200);
    const searchBody = await searchRes.json();
    expect(
      searchBody.items.some(
        (item: { slug: string; excerpt: string }) =>
          item.slug === "engineering/onboarding" && item.excerpt.length > 0,
      ),
    ).toBe(true);

    const historyRes = await app.request("http://localhost/api/history/engineering/onboarding");
    expect(historyRes.status).toBe(200);
    const historyBody = await historyRes.json();
    expect(historyBody.items.length).toBeGreaterThanOrEqual(2);

    const toCommit = historyBody.items[0].commit as string;
    const fromCommit = historyBody.items[1].commit as string;

    const diffRes = await app.request(
      `http://localhost/api/diff/engineering/onboarding?from=${encodeURIComponent(fromCommit)}&to=${encodeURIComponent(toCommit)}`,
    );
    expect(diffRes.status).toBe(200);
    const diffBody = await diffRes.json();
    expect(diffBody.diff).toContain("Deployment checklist");

    const deleteRes = await app.request("http://localhost/api/pages/engineering/onboarding", {
      method: "DELETE",
      headers: writeHeaders,
    });
    expect(deleteRes.status).toBe(200);

    const missingRes = await app.request("http://localhost/api/pages/engineering/onboarding");
    expect(missingRes.status).toBe(404);
  });

  it("supports the home slug and rejects duplicate or unsafe slugs", async () => {
    const app = createApp();

    const homeCreateRes = await app.request("http://localhost/api/pages", {
      method: "POST",
      headers: jsonWriteHeaders,
      body: JSON.stringify({
        slug: "",
        title: "Home",
        body: "# Home\n\nTeam entrypoint.",
      }),
    });

    expect(homeCreateRes.status).toBe(200);

    const homeReadRes = await app.request("http://localhost/api/pages/");
    expect(homeReadRes.status).toBe(200);
    const homeBody = await homeReadRes.json();
    expect(homeBody.slug).toBe("");
    expect(homeBody.title).toBe("Home");

    const duplicateRes = await app.request("http://localhost/api/pages", {
      method: "POST",
      headers: jsonWriteHeaders,
      body: JSON.stringify({
        slug: "",
        title: "Duplicate Home",
        body: "should not overwrite",
      }),
    });
    expect(duplicateRes.status).toBe(409);

    const unsafeCreateRes = await app.request("http://localhost/api/pages", {
      method: "POST",
      headers: jsonWriteHeaders,
      body: JSON.stringify({
        slug: "../escape",
        title: "Escape",
        body: "should not write outside pages",
      }),
    });
    expect(unsafeCreateRes.status).toBe(400);

    const unsafeReadRes = await app.request("http://localhost/api/pages/%00");
    expect(unsafeReadRes.status).toBe(400);

    const malformedReadRes = await app.request("http://localhost/api/pages/%E0%A4%A");
    expect(malformedReadRes.status).toBe(400);
  });

  it("normalizes safe slug input before writing files", async () => {
    const app = createApp();

    const createRes = await app.request("http://localhost/api/pages", {
      method: "POST",
      headers: jsonWriteHeaders,
      body: JSON.stringify({
        slug: " /guides//release/ ",
        title: "Release Guide",
        body: "Normalized slug content",
      }),
    });

    expect(createRes.status).toBe(200);
    const createBody = await createRes.json();
    expect(createBody.slug).toBe("guides/release");

    const pageRes = await app.request("http://localhost/api/pages/guides/release");
    expect(pageRes.status).toBe(200);
    const pageBody = await pageRes.json();
    expect(pageBody.path).toBe("guides/release.md");
  });

  it("sanitizes unsafe markdown and title content before saving", async () => {
    const app = createApp();

    const createRes = await app.request("http://localhost/api/pages", {
      method: "POST",
      headers: jsonWriteHeaders,
      body: JSON.stringify({
        slug: "security/sanitize",
        title: "<img src=x onerror=alert(1)>Safe Title",
        body: [
          "# Unsafe",
          "<script>alert(1)</script>",
          '<img src="https://example.com/image.png" onerror="alert(1)">',
          "[bad](javascript:alert(1))",
          "![bad](data:text/html;base64,PHNjcmlwdA==)",
          "[escape](./../private)",
          "[root escape](/../private)",
          "![bad-mailto](mailto:test@example.com)",
        ].join("\n"),
      }),
    });
    expect(createRes.status).toBe(200);

    const pageRes = await app.request("http://localhost/api/pages/security/sanitize");
    expect(pageRes.status).toBe(200);
    const pageBody = await pageRes.json();
    expect(pageBody.title).toBe("Safe Title");
    expect(pageBody.body).not.toContain("<script");
    expect(pageBody.body).not.toContain("onerror");
    expect(pageBody.body).not.toContain("javascript:");
    expect(pageBody.body).not.toContain("data:text/html");
    expect(pageBody.body).not.toContain("./../private");
    expect(pageBody.body).not.toContain("/../private");
    expect(pageBody.body).not.toContain("mailto:test@example.com");
    expect(pageBody.body).toContain("#blocked-unsafe-url");
  });

  it("preserves index.md-backed page paths when updating the same slug", async () => {
    const app = createApp();
    const pageDir = path.join(tempRoot, "pages", "section");
    const indexPath = path.join(pageDir, "index.md");

    await fs.mkdir(pageDir, { recursive: true });
    await fs.writeFile(
      indexPath,
      "---\ntitle: Section\nshowOnMenu: true\n---\nOriginal index body\n",
      "utf8",
    );

    const updateRes = await app.request("http://localhost/api/pages/section", {
      method: "PUT",
      headers: jsonWriteHeaders,
      body: JSON.stringify({
        title: "Section",
        body: "Updated index body",
        meta: {
          showOnMenu: true,
        },
      }),
    });

    expect(updateRes.status).toBe(200);
    await expect(fs.access(indexPath)).resolves.toBe(undefined);
    await expect(fs.access(path.join(tempRoot, "pages", "section.md"))).rejects.toThrow();

    const pageRes = await app.request("http://localhost/api/pages/section");
    expect(pageRes.status).toBe(200);
    const pageBody = await pageRes.json();
    expect(pageBody.path).toBe("section/index.md");
    expect(pageBody.body).toContain("Updated index body");
  });

  it("renames a page when the slug changes", async () => {
    const app = createApp();

    const createRes = await app.request("http://localhost/api/pages", {
      method: "POST",
      headers: jsonWriteHeaders,
      body: JSON.stringify({
        slug: "guides/draft",
        title: "Draft Guide",
        body: "draft rename target content",
      }),
    });
    expect(createRes.status).toBe(200);

    const renameRes = await app.request("http://localhost/api/pages/guides/draft", {
      method: "PUT",
      headers: jsonWriteHeaders,
      body: JSON.stringify({
        slug: "guides/published",
        title: "Published Guide",
        body: "published rename target content",
      }),
    });
    expect(renameRes.status).toBe(200);
    const renameBody = await renameRes.json();
    expect(renameBody.slug).toBe("guides/published");
    expect(renameBody.commit).toBeTruthy();

    await expect(fs.access(path.join(tempRoot, "pages", "guides", "draft.md"))).rejects.toThrow();
    await expect(fs.access(path.join(tempRoot, "pages", "guides", "published.md"))).resolves.toBe(
      undefined,
    );

    const oldReadRes = await app.request("http://localhost/api/pages/guides/draft");
    expect(oldReadRes.status).toBe(404);

    const newReadRes = await app.request("http://localhost/api/pages/guides/published");
    expect(newReadRes.status).toBe(200);
    const newReadBody = await newReadRes.json();
    expect(newReadBody.title).toBe("Published Guide");
    expect(newReadBody.path).toBe("guides/published.md");

    const treeRes = await app.request("http://localhost/api/pages/tree");
    const treeBody = await treeRes.json();
    const treeSlugs = treeBody.items.map((item: { slug: string }) => item.slug);
    expect(treeSlugs).toContain("guides/published");
    expect(treeSlugs).not.toContain("guides/draft");

    const conflictRes = await app.request("http://localhost/api/pages", {
      method: "POST",
      headers: jsonWriteHeaders,
      body: JSON.stringify({
        slug: "guides/conflict",
        title: "Conflict Guide",
        body: "conflict content",
      }),
    });
    expect(conflictRes.status).toBe(200);

    const renameConflictRes = await app.request("http://localhost/api/pages/guides/published", {
      method: "PUT",
      headers: jsonWriteHeaders,
      body: JSON.stringify({
        slug: "guides/conflict",
        title: "Should Not Overwrite",
        body: "conflict should not overwrite",
      }),
    });
    expect(renameConflictRes.status).toBe(409);
  });

  it("supports folder create, rename and recursive delete", async () => {
    const app = createApp();

    const createFolderRes = await app.request("http://localhost/api/folders", {
      method: "POST",
      headers: jsonWriteHeaders,
      body: JSON.stringify({
        path: "docs/guides",
      }),
    });
    expect(createFolderRes.status).toBe(200);
    const createFolderBody = await createFolderRes.json();
    expect(createFolderBody.path).toBe("docs/guides");
    await expect(
      fs.access(path.join(tempRoot, "pages", "docs", "guides", ".gitkeep")),
    ).resolves.toBe(undefined);

    const folderTreeRes = await app.request("http://localhost/api/pages/tree");
    expect(folderTreeRes.status).toBe(200);
    const folderTreeBody = await folderTreeRes.json();
    const folderPaths = folderTreeBody.folders.map((item: { path: string }) => item.path);
    expect(folderPaths).toContain("docs");
    expect(folderPaths).toContain("docs/guides");

    const createPageRes = await app.request("http://localhost/api/pages", {
      method: "POST",
      headers: jsonWriteHeaders,
      body: JSON.stringify({
        slug: "docs/guides/install",
        title: "Install Guide",
        body: "Install steps",
      }),
    });
    expect(createPageRes.status).toBe(200);

    const renameFolderRes = await app.request("http://localhost/api/folders/docs/guides", {
      method: "PUT",
      headers: jsonWriteHeaders,
      body: JSON.stringify({
        path: "knowledge/guides",
      }),
    });
    expect(renameFolderRes.status).toBe(200);
    const renameFolderBody = await renameFolderRes.json();
    expect(renameFolderBody.path).toBe("knowledge/guides");
    expect(renameFolderBody.movedPages).toContainEqual({
      from: "docs/guides/install",
      to: "knowledge/guides/install",
    });
    await expect(fs.access(path.join(tempRoot, "pages", "docs", "guides"))).rejects.toThrow();
    await expect(
      fs.access(path.join(tempRoot, "pages", "knowledge", "guides", "install.md")),
    ).resolves.toBe(undefined);

    const oldPageRes = await app.request("http://localhost/api/pages/docs/guides/install");
    expect(oldPageRes.status).toBe(404);
    const movedPageRes = await app.request("http://localhost/api/pages/knowledge/guides/install");
    expect(movedPageRes.status).toBe(200);

    const conflictFolderRes = await app.request("http://localhost/api/folders", {
      method: "POST",
      headers: jsonWriteHeaders,
      body: JSON.stringify({
        path: "knowledge/archive",
      }),
    });
    expect(conflictFolderRes.status).toBe(200);

    const renameConflictRes = await app.request("http://localhost/api/folders/knowledge/guides", {
      method: "PUT",
      headers: jsonWriteHeaders,
      body: JSON.stringify({
        path: "knowledge/archive",
      }),
    });
    expect(renameConflictRes.status).toBe(409);

    const deleteFolderRes = await app.request("http://localhost/api/folders/knowledge/guides", {
      method: "DELETE",
      headers: writeHeaders,
    });
    expect(deleteFolderRes.status).toBe(200);
    const deleteFolderBody = await deleteFolderRes.json();
    expect(deleteFolderBody.deletedSlugs).toContain("knowledge/guides/install");

    const deletedPageRes = await app.request("http://localhost/api/pages/knowledge/guides/install");
    expect(deletedPageRes.status).toBe(404);
  });

  it("reindex rebuilds search and removes stale rows", async () => {
    const app = createApp();

    await app.request("http://localhost/api/pages", {
      method: "POST",
      headers: jsonWriteHeaders,
      body: JSON.stringify({
        slug: "guides/release",
        title: "Release Guide",
        body: "release checklist and rollback notes",
      }),
    });

    let reindexRes = await app.request("http://localhost/api/reindex", {
      method: "POST",
      headers: writeHeaders,
    });
    expect(reindexRes.status).toBe(200);
    let reindexBody = await reindexRes.json();
    expect(reindexBody.ok).toBe(true);
    expect(reindexBody.indexed).toBeGreaterThanOrEqual(1);

    const searchBeforeDelete = await app.request("http://localhost/api/search?q=rollback");
    const beforeBody = await searchBeforeDelete.json();
    expect(beforeBody.items.some((item: { slug: string }) => item.slug === "guides/release")).toBe(
      true,
    );

    await fs.rm(path.join(tempRoot, "pages", "guides", "release.md"), { force: true });

    reindexRes = await app.request("http://localhost/api/reindex", {
      method: "POST",
      headers: writeHeaders,
    });
    reindexBody = await reindexRes.json();
    expect(reindexBody.removed).toBeGreaterThanOrEqual(1);

    const searchAfterDelete = await app.request("http://localhost/api/search?q=rollback");
    const afterBody = await searchAfterDelete.json();
    expect(afterBody.items.some((item: { slug: string }) => item.slug === "guides/release")).toBe(
      false,
    );
  });
});
