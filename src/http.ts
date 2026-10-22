/** すべての動的レスポンスに付与するセキュリティヘッダー。 */
const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

/** Worker が返す HTML ページ用の CSP（インラインスクリプト・外部リソースを一切許可しない）。 */
const PAGE_CSP =
  "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

export function noContent(headers: Record<string, string> = {}): Response {
  return new Response(null, {
    status: 204,
    headers: { ...SECURITY_HEADERS, "Cache-Control": "no-store", ...headers },
  });
}

export interface ApiErrorBody {
  error: { code: string; message: string; field?: "url" | "slug" | "token" };
}

/** API のエラー応答。内部実装の詳細は含めず、利用者向けのメッセージだけを返す。 */
export function apiError(
  status: number,
  code: string,
  message: string,
  options: { field?: ApiErrorBody["error"]["field"]; headers?: Record<string, string> } = {},
): Response {
  const body: ApiErrorBody = { error: { code, message } };
  if (options.field) body.error.field = options.field;
  return json(body, status, options.headers);
}

export function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      ...SECURITY_HEADERS,
      Location: location,
      // クリック数を正確に数えるため、ブラウザや中間キャッシュに転送結果を保存させない。
      "Cache-Control": "private, no-store",
    },
  });
}

/** 404 / 500 などの簡素な HTML ページ。文言は固定文字列のみで、リクエスト内容は反映しない。 */
export function htmlPage(
  status: number,
  title: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  const body = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} — PK Short</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css">
</head>
<body class="page-status">
<main class="status-page">
<p class="status-code">${status}</p>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<p><a href="/">PK Short へ戻る</a></p>
</main>
</body>
</html>`;
  return new Response(body, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": PAGE_CSP,
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** ログ用にエラーを要約する（スタックやバインド値は出さない）。 */
export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
}
