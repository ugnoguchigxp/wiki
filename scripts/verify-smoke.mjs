import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiEntry = resolve(rootDir, "apps/api/dist/index.js");
const publicIndex = resolve(rootDir, "apps/api/public/index.html");

const getFreePort = () =>
  new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === "string") {
          reject(new Error("Failed to allocate a smoke test port"));
          return;
        }
        resolvePort(address.port);
      });
    });
  });

const waitForJson = async (url, timeoutMs = 10_000) => {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return await response.json();
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }

  throw lastError ?? new Error(`Timed out waiting for ${url}`);
};

const requestText = async (url) => {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${text}`);
  }
  return { response, text };
};

const waitForExit = (processToWait) =>
  new Promise((resolveExit) => {
    if (processToWait.exitCode !== null || processToWait.signalCode !== null) {
      resolveExit();
      return;
    }
    processToWait.once("exit", () => resolveExit());
  });

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

if (!existsSync(apiEntry) || !existsSync(publicIndex)) {
  throw new Error("Smoke test requires built API and public assets. Run `pnpm build` first.");
}

const port = String(await getFreePort());
const baseUrl = `http://127.0.0.1:${port}`;
const contentRoot = await mkdtemp(resolve(tmpdir(), "wiki-smoke-"));
await mkdir(resolve(contentRoot, "pages"), { recursive: true });
await mkdir(resolve(contentRoot, ".wiki"), { recursive: true });
await writeFile(
  resolve(contentRoot, "pages/index.md"),
  "---\ntitle: Smoke Home\n---\n# Smoke Wiki\n\nThis page verifies wiki search.\n",
  "utf8",
);

const child = spawn(process.execPath, [apiEntry], {
  cwd: rootDir,
  env: {
    ...process.env,
    PORT: port,
    CONTENT_ROOT: contentRoot,
    DATABASE_PATH: resolve(contentRoot, ".wiki/wiki.sqlite"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

try {
  const health = await waitForJson(`${baseUrl}/api/health`);
  assert(health.ok === true, "health endpoint did not return ok=true");

  const root = await requestText(`${baseUrl}/`);
  assert(
    root.response.headers.get("content-type")?.includes("text/html"),
    "root route did not serve HTML",
  );
  assert(root.text.includes('<div id="root">'), "root HTML does not look like the React app");

  const tree = await waitForJson(`${baseUrl}/api/pages/tree`);
  assert(Array.isArray(tree.items), "page tree did not return an items array");

  const home = await waitForJson(`${baseUrl}/api/pages/`);
  assert(typeof home.slug === "string", "home page response is missing slug");

  const search = await waitForJson(`${baseUrl}/api/search?q=wiki`);
  assert(Array.isArray(search.items), "search endpoint did not return an items array");

  console.log(`smoke ok: ${baseUrl}`);
} catch (error) {
  console.error(output.trim());
  throw error;
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 1_000);
    await waitForExit(child);
    clearTimeout(killTimer);
  }
  await rm(contentRoot, { recursive: true, force: true });
}
