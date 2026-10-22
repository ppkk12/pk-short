import { handleApi } from "./api";
import type { Env } from "./env";
import { apiError, describeError, htmlPage } from "./http";
import { handleRedirect } from "./redirect";

/**
 * PK Short — エントリポイント。
 *
 * 静的ファイル（管理画面 `/`, `/app.js`, `/styles.css` など）は Workers Static Assets が
 * Worker より先に配信する。一致するファイルがないリクエストだけがここに届く。
 */
export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
    try {
      return isApi ? await handleApi(request, env, url) : await handleRedirect(request, env, ctx, url);
    } catch (error) {
      // DB 障害などの想定外エラー。内部情報（SQL・スタック・秘密値）は応答に含めない。
      console.error("[pk-short] unhandled error", describeError(error));
      return isApi
        ? apiError(500, "internal_error", "サーバーで問題が発生しました。時間をおいて再度お試しください。")
        : htmlPage(503, "一時的に利用できません", "時間をおいて再度アクセスしてください。", { "Retry-After": "30" });
    }
  },
} satisfies ExportedHandler<Env>;
