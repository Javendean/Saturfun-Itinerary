import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { fileURLToPath } from "node:url";

// Resolve ./migrations relative to this config (Node 22 / ESM-safe).
const migrationsPath = fileURLToPath(new URL("./migrations", import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      // Read the real .sql migration files so the test D1 has the photos table.
      const migrations = await readD1Migrations(migrationsPath);
      return {
        // Load PHOTOS_BUCKET (R2), DB (D1), RATE_LIMIT (KV) + vars from the TEST
        // config (omits [ai], which has no local emulator and forces a remote session).
        wrangler: { configPath: "./wrangler.test.toml" },
        miniflare: {
          // Hand the parsed migrations to the setup file via a test-only binding.
          bindings: { TEST_MIGRATIONS: migrations },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    include: ["test/**/*.spec.ts"],
  },
});
