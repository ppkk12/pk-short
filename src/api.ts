import {
  authenticate,
  clearSessionCookie,
  createSessionCookie,
  getAdminToken,
  isTrustedOrigin,
  safeEqual,
  type AuthMethod,
} from "./auth";
import {
  DEFAULT_CREATE_LIMIT_PER_DAY,
  DEFAULT_PUBLIC_CREATE_LIMIT_PER_DAY,
  DEFAULT_PUBLIC_CREATE_LIMIT_PER_MINUTE,
  GENERATED_SLUG_ATTEMPTS,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  LOGIN_LIMIT,
  MAX_JSON_BODY_BYTES,
  PUBLIC_SLUG_MIN_LENGTH,
  RATE_LIMIT_CLEANUP_PROBABILITY,
  RATE_LIMIT_RETENTION_SECONDS,
} from "./config";
import { validateDestination } from "./destination";
import type { Env } from "./env";
import { apiError, json, noContent } from "./http";
import { deleteLink, insertLink, listLinks, toLink, type LinkRow } from "./links";
import { consumeRateLimits, hashClientIp, type RateLimitRule } from "./rate-limit";
import { generateSlug, isReservedSlug, isValidSlugFormat, validateCustomSlug } from "./slug";

/**
 * API。
 *
 *   GET    /api/health        ヘルスチェック（公開）
 *   GET    /api/session       認証状態・一般作成の可否（公開）
 *   POST   /api/session       管理者ログイン（トークン → セッション Cookie）
 *   DELETE /api/session       ログアウト
 *   POST   /api/links         作成（ログイン不要。未ログインは IP ごとの上限あり）
 *   GET    /api/links         一覧（管理者のみ）
 *   DELETE /api/links/:slug   削除（管理者のみ）
 */
export async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/health") {
    return method === "GET" || method === "HEAD" ? json({ status: "ok" }) : methodNotAllowed("GET, HEAD");
  }

  if (pathname === "/api/session") {
    switch (method) {
      case "GET":
        return getSession(request, env, url);
      case "POST":
        return login(request, env, url);
      case "DELETE":
        return logout(request, url);
      default:
        return methodNotAllowed("GET, POST, DELETE");
    }
  }

  if (pathname === "/api/links") {
    switch (method) {
      case "GET":
        return withAdmin(request, env, url, () => list(env, url));
      case "POST":
        return createEndpoint(request, env, url);
      default:
        return methodNotAllowed("GET, POST");
    }
  }

  const linkPath = /^\/api\/links\/([^/]+)$/.exec(pathname);
  if (linkPath) {
    return method === "DELETE"
      ? withAdmin(request, env, url, () => remove(env, linkPath[1]))
      : methodNotAllowed("DELETE");
  }

  return apiError(404, "not_found", "指定されたAPIは存在しません。");
}

/** 認証と CSRF チェックを通過したリクエストだけを handler に渡す。 */
async function withAdmin(
  request: Request,
  env: Env,
  url: URL,
  handler: () => Promise<Response>,
): Promise<Response> {
  const token = getAdminToken(env);
  if (token === null) return authNotConfigured();

  const method = await authenticate(request, token, url);
  if (method === null) return unauthorized();
  if (!isSafeMethod(request.method) && !isTrustedOrigin(request, url, method === "session")) {
    return forbiddenOrigin();
  }
  return handler();
}

/**
 * 短縮URLの作成。管理者はそのまま、ログインしていない利用者は
 * 一般作成が有効な場合に限り、IP ごとの上限と短縮キーの長さ制限つきで作成できる。
 */
async function createEndpoint(request: Request, env: Env, url: URL): Promise<Response> {
  // 別オリジンのページからの送信は、認証の有無にかかわらず拒否する。
  if (!isTrustedOrigin(request, url, false)) return forbiddenOrigin();

  const token = getAdminToken(env);
  let method: AuthMethod | null = null;
  if (token !== null) {
    method = await authenticate(request, token, url);
    if (method === "session" && !isTrustedOrigin(request, url, true)) return forbiddenOrigin();
  }
  // 誤った Bearer トークンは匿名扱いにせず、明示的に拒否する。
  if (method === null && request.headers.has("Authorization")) return unauthorized();

  if (method === null && !isPublicCreateEnabled(env)) {
    return apiError(403, "public_create_disabled", "現在、ログインなしでの短縮URLの作成は停止しています。");
  }
  return create(request, env, url, method !== null);
}

async function getSession(request: Request, env: Env, url: URL): Promise<Response> {
  const token = getAdminToken(env);
  const authenticated = token !== null && (await authenticate(request, token, url)) !== null;
  return json({ authConfigured: token !== null, authenticated, publicCreate: isPublicCreateEnabled(env) });
}

async function login(request: Request, env: Env, url: URL): Promise<Response> {
  const token = getAdminToken(env);
  if (token === null) return authNotConfigured();
  if (!isTrustedOrigin(request, url, false)) return forbiddenOrigin();

  const body = await readJsonObject(request);
  if (!body.ok) return body.response;

  const allowed = await consumeRateLimits(
    env.DB,
    [{ key: `login:${await hashClientIp(request, "login")}`, ...LOGIN_LIMIT }],
    Date.now(),
    { keyPrefix: "login:", olderThanSeconds: LOGIN_LIMIT.windowSeconds * 2 },
  );
  if (!allowed) {
    return apiError(429, "too_many_attempts", "ログインの試行回数が多すぎます。15分ほど待ってから再度お試しください。", {
      headers: { "Retry-After": String(LOGIN_LIMIT.windowSeconds) },
    });
  }

  const supplied = body.value.token;
  if (typeof supplied !== "string" || !(await safeEqual(supplied.trim(), token))) {
    return apiError(401, "invalid_token", "管理トークンが正しくありません。", { field: "token" });
  }
  return json({ authenticated: true }, 200, { "Set-Cookie": await createSessionCookie(token, url) });
}

function logout(request: Request, url: URL): Response {
  if (!isTrustedOrigin(request, url, false)) return forbiddenOrigin();
  return noContent({ "Set-Cookie": clearSessionCookie(url) });
}

async function list(env: Env, url: URL): Promise<Response> {
  const cursorParam = url.searchParams.get("cursor");
  const cursor = cursorParam === null ? null : parsePositiveInt(cursorParam);
  if (cursorParam !== null && cursor === null) {
    return apiError(400, "invalid_cursor", "cursor の値が正しくありません。");
  }
  const limit = Math.min(parsePositiveInt(url.searchParams.get("limit")) ?? LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);

  // 1件多く取得して次ページの有無を判定する。
  const { rows, total } = await listLinks(env.DB, { cursor, limit: limit + 1 });
  const page = rows.slice(0, limit);
  return json({
    links: page.map((row) => toLink(row, url.origin)),
    total,
    nextCursor: rows.length > limit ? page[page.length - 1].id : null,
  });
}

async function create(request: Request, env: Env, url: URL, isAdmin: boolean): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body.ok) return body.response;

  const destination = validateDestination(body.value.url, url.hostname);
  if (!destination.ok) return apiError(400, "invalid_url", destination.message, { field: "url" });

  const rawSlug = body.value.slug;
  let customSlug = "";
  if (typeof rawSlug === "string") {
    customSlug = rawSlug.trim();
  } else if (rawSlug !== undefined && rawSlug !== null) {
    return apiError(400, "invalid_slug", "短縮キーは文字列で指定してください。", { field: "slug" });
  }
  if (customSlug !== "") {
    const check = validateCustomSlug(customSlug, isAdmin ? 1 : PUBLIC_SLUG_MIN_LENGTH);
    if (!check.ok) return apiError(400, "invalid_slug", check.message, { field: "slug" });
  }

  const ipHash = isAdmin ? null : await hashClientIp(request, "create");
  const cleanup =
    ipHash !== null && Math.random() < RATE_LIMIT_CLEANUP_PROBABILITY
      ? { keyPrefix: "ip:", olderThanSeconds: RATE_LIMIT_RETENTION_SECONDS }
      : undefined;
  if (!(await consumeRateLimits(env.DB, createLimitRules(env, ipHash), Date.now(), cleanup))) {
    return apiError(429, "rate_limited", "短時間に作成が集中しています。しばらく待ってから再度お試しください。", {
      headers: { "Retry-After": "60" },
    });
  }

  if (customSlug !== "") {
    const row = await insertLink(env.DB, customSlug, destination.url);
    if (row === null) {
      return apiError(409, "slug_taken", `短縮キー「${customSlug}」は既に使われています。別のキーを指定してください。`, {
        field: "slug",
      });
    }
    return created(row, url);
  }

  // 任意キーが空欄なら自動生成する。万一衝突した場合は別のキーで再試行する。
  for (let attempt = 0; attempt < GENERATED_SLUG_ATTEMPTS; attempt++) {
    const slug = generateSlug();
    if (isReservedSlug(slug)) continue;
    const row = await insertLink(env.DB, slug, destination.url);
    if (row !== null) return created(row, url);
  }
  console.error("[pk-short] could not generate a unique slug");
  return apiError(500, "slug_generation_failed", "短縮キーを生成できませんでした。もう一度お試しください。");
}

async function remove(env: Env, encodedSlug: string): Promise<Response> {
  let slug = "";
  try {
    slug = decodeURIComponent(encodedSlug);
  } catch {
    // 不正なエンコードは「存在しない」と同じ扱いにする。
  }
  if (!isValidSlugFormat(slug) || !(await deleteLink(env.DB, slug))) {
    return apiError(404, "not_found", "指定された短縮URLは見つかりません。");
  }
  return noContent();
}

function created(row: LinkRow, url: URL): Response {
  return json({ link: toLink(row, url.origin) }, 201);
}

/**
 * 作成数の上限。サービス全体の1日上限は全員に、IP ごとの上限はログインしていない利用者に適用する。
 * D1 の無料枠（書き込み 10 万行/日）を使い切らないよう、全体上限は控えめにしている。
 */
function createLimitRules(env: Env, ipHash: string | null): RateLimitRule[] {
  const rules: RateLimitRule[] = [
    {
      key: "create:day",
      limit: parsePositiveInt(env.CREATE_LIMIT_PER_DAY) ?? DEFAULT_CREATE_LIMIT_PER_DAY,
      windowSeconds: 60 * 60 * 24,
    },
  ];
  if (ipHash !== null) {
    rules.push(
      {
        key: `ip:min:${ipHash}`,
        limit: parsePositiveInt(env.PUBLIC_CREATE_LIMIT_PER_MINUTE) ?? DEFAULT_PUBLIC_CREATE_LIMIT_PER_MINUTE,
        windowSeconds: 60,
      },
      {
        key: `ip:day:${ipHash}`,
        limit: parsePositiveInt(env.PUBLIC_CREATE_LIMIT_PER_DAY) ?? DEFAULT_PUBLIC_CREATE_LIMIT_PER_DAY,
        windowSeconds: 60 * 60 * 24,
      },
    );
  }
  return rules;
}

function isPublicCreateEnabled(env: Env): boolean {
  return env.PUBLIC_CREATE_ENABLED?.trim().toLowerCase() !== "false";
}

type JsonObjectResult = { ok: true; value: Record<string, unknown> } | { ok: false; response: Response };

async function readJsonObject(request: Request): Promise<JsonObjectResult> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(contentType)) {
    return {
      ok: false,
      response: apiError(415, "unsupported_media_type", "Content-Type: application/json で送信してください。"),
    };
  }
  const tooLarge = (): JsonObjectResult => ({
    ok: false,
    response: apiError(413, "payload_too_large", "リクエストが大きすぎます。"),
  });
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_JSON_BODY_BYTES) return tooLarge();

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BODY_BYTES) return tooLarge();

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, response: apiError(400, "invalid_json", "リクエストの形式が正しくありません。") };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

function parsePositiveInt(value: string | null | undefined): number | null {
  if (value == null || !/^\d{1,15}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed > 0 ? parsed : null;
}

function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function methodNotAllowed(allow: string): Response {
  return apiError(405, "method_not_allowed", "このメソッドは使用できません。", { headers: { Allow: allow } });
}

function unauthorized(): Response {
  return apiError(401, "unauthorized", "認証が必要です。管理トークンでログインしてください。", {
    headers: { "WWW-Authenticate": 'Bearer realm="pk-short"' },
  });
}

function authNotConfigured(): Response {
  return apiError(
    503,
    "auth_not_configured",
    "管理トークン（ADMIN_TOKEN）が設定されていないため、管理操作は無効になっています。",
  );
}

function forbiddenOrigin(): Response {
  return apiError(403, "forbidden_origin", "このリクエストは許可されていません。");
}
