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

  it("supports page CRUD, search, history and diff", async () => {
    const app = createApp();

    const createRes = await app.request("http://localhost/api/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
      headers: { "Content-Type": "application/json" },
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
    });
    expect(deleteRes.status).toBe(200);

    const missingRes = await app.request("http://localhost/api/pages/engineering/onboarding");
    expect(missingRes.status).toBe(404);
  });

  it("supports the home slug and rejects duplicate or unsafe slugs", async () => {
    const app = createApp();

    const homeCreateRes = await app.request("http://localhost/api/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "",
        title: "Duplicate Home",
        body: "should not overwrite",
      }),
    });
    expect(duplicateRes.status).toBe(409);

    const unsafeCreateRes = await app.request("http://localhost/api/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

  it("reindex rebuilds search and removes stale rows", async () => {
    const app = createApp();

    await app.request("http://localhost/api/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "guides/release",
        title: "Release Guide",
        body: "release checklist and rollback notes",
      }),
    });

    let reindexRes = await app.request("http://localhost/api/reindex", {
      method: "POST",
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
