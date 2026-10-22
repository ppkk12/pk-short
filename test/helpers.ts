import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Env } from "../src/env";
import worker from "../src/index";
import type { Link } from "../src/links";

/** テスト中の「デプロイ先ホスト」。短縮URLはこのオリジンから生成される。 */
export const ORIGIN = "https://pk-short.example.workers.dev";
/** vitest.config.ts で設定したテスト用トークン。 */
export const ADMIN_TOKEN = "test-admin-token-0123456789";

export const EXAMPLE_URL = "https://example.com/products/category/item?id=12345";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
type IncomingRequestInit = RequestInit<IncomingRequestCfProperties>;

/**
 * Worker の fetch ハンドラを直接呼び出し、waitUntil（クリック数の更新など）の完了まで待つ。
 * overrides で環境変数やバインディングを差し替えられる。
 */
export async function call(
  path: string,
  init: IncomingRequestInit = {},
  overrides: Partial<Env> = {},
): Promise<Response> {
  const request = new IncomingRequest(new URL(path, ORIGIN), init);
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, { ...env, ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

export function bearer(token: string = ADMIN_TOKEN): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export function createLink(
  body: unknown,
  headers: Record<string, string> = bearer(),
  overrides: Partial<Env> = {},
): Promise<Response> {
  return call(
    "/api/links",
    { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) },
    overrides,
  );
}

export async function createLinkOk(body: { url: string; slug?: string }): Promise<Link> {
  const response = await createLink(body);
  if (response.status !== 201) {
    throw new Error(`作成に失敗しました: ${response.status} ${await response.text()}`);
  }
  return (await response.json<{ link: Link }>()).link;
}

export async function resetDatabase(): Promise<void> {
  await env.DB.batch([env.DB.prepare("DELETE FROM short_urls"), env.DB.prepare("DELETE FROM rate_limits")]);
}

export async function countRows(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM short_urls").first<{ n: number }>();
  return row?.n ?? 0;
}

export interface ErrorBody {
  error: { code: string; message: string; field?: string };
}
