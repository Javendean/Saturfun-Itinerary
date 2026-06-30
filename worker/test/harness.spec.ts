// Harness sanity check: proves R2 + D1 bindings resolve and the photos
// migration was applied before tests run. Not a feature test.
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("test harness", () => {
  it("binds D1 + R2 and applies the photos migration", async () => {
    expect(env.DB).toBeDefined();
    expect(env.PHOTOS_BUCKET).toBeDefined();
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM photos").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});
