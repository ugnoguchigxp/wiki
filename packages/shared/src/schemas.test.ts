import { describe, expect, it } from "vitest";
import { healthResponseSchema } from "./schemas.js";

describe("healthResponseSchema", () => {
  it("accepts the expected payload", () => {
    const parsed = healthResponseSchema.parse({
      ok: true,
      app: "wiki-api",
      version: "0.0.0",
      contentRoot: "/tmp/wiki-knowledge",
      databasePath: "/tmp/wiki.sqlite",
      git: {
        branch: "main",
        commit: "abc123",
      },
    });

    expect(parsed.ok).toBe(true);
  });
});
