import type { Env } from "./env";
import { describeError, htmlPage, redirect } from "./http";
import { findDestination, incrementClickCount } from "./links";
import { isValidSlugFormat } from "./slug";

/**
 * `GET /:slug` — 登録済みの転送先へ 302 でリダイレクトする（認証不要の公開エンドポイント）。
 * 転送先は必ず DB に登録された値で、リクエストのパラメータからは指定できない。
 */
export async function handleRedirect(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return htmlPage(405, "このメソッドは使用できません", "短縮URLは GET でアクセスしてください。", {
      Allow: "GET, HEAD",
    });
  }

  const slug = url.pathname.slice(1);
  if (!isValidSlugFormat(slug)) return notFound();

  const destination = await findDestination(env.DB, slug);
  if (destination === null) return notFound();

  if (request.method === "GET") {
    // クリック数の更新はレスポンス返却後に行い、失敗してもリダイレクトは妨げない。
    ctx.waitUntil(
      incrementClickCount(env.DB, slug).catch((error: unknown) => {
        console.error("[pk-short] failed to update click count", describeError(error));
      }),
    );
  }
  return redirect(destination);
}

function notFound(): Response {
  return htmlPage(404, "リンクが見つかりません", "この短縮URLは存在しないか、削除された可能性があります。");
}
