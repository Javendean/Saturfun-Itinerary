// Runs once before the suite: create the photos table in the isolated test D1.
import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";

const migrations = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
await applyD1Migrations(env.DB, migrations);
