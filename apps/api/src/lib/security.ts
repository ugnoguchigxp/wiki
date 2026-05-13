import type { Context, Next } from "hono";

const writeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const localHostnames = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export const wikiRequestHeader = "X-Wiki-Request";
export const wikiRequestHeaderValue = "local";

const isLocalOrigin = (origin: string): boolean => {
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      localHostnames.has(parsed.hostname)
    );
  } catch {
    return false;
  }
};

export const resolveCorsOrigin = (origin: string): string | null =>
  origin && isLocalOrigin(origin) ? origin : null;

export const securityHeadersMiddleware = async (c: Context, next: Next) => {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  c.header(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "img-src 'self' http: https: blob:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self' http://localhost:* http://127.0.0.1:* http://[::1]:* ws://localhost:* ws://127.0.0.1:* ws://[::1]:*",
    ].join("; "),
  );
  await next();
};

export const localApiWriteGuardMiddleware = async (c: Context, next: Next) => {
  const origin = c.req.header("Origin");
  if (origin && !isLocalOrigin(origin)) {
    return c.json({ message: "Forbidden origin" }, 403);
  }

  if (writeMethods.has(c.req.method)) {
    const requestHeader = c.req.header(wikiRequestHeader);
    if (requestHeader !== wikiRequestHeaderValue) {
      return c.json({ message: `Missing ${wikiRequestHeader}` }, 403);
    }
  }

  await next();
};
