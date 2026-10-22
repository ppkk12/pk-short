import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/** テスト専用の管理トークン（本番の値とは無関係）。test/helpers.ts と一致させる。 */
const TEST_ADMIN_TOKEN = "test-admin-token-0123456789";

export default defineConfig(async () => {
  // 本番・ローカルと同じマイグレーションファイルをテスト用 D1 に適用する。
  const migrations = await readD1Migrations("./migrations");

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            ADMIN_TOKEN: TEST_ADMIN_TOKEN,
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      // 全テストが同じ D1 を使うため、ファイル間で並列実行しない。
      fileParallelism: false,
    },
  };
});
