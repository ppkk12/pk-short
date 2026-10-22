import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// migrations/*.sql をテスト用 D1 に適用する（適用済みのものはスキップされる）。
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
