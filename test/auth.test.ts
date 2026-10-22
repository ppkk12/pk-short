import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createSessionCookie } from "../src/auth";
import {
  ADMIN_TOKEN,
  EXAMPLE_URL,
  ORIGIN,
  bearer,
  call,
  countRows,
  createLink,
  createLinkOk,
  resetDatabase,
  type ErrorBody,
} from "./helpers";

beforeEach(resetDatabase);

const JSON_HEADERS = { "Content-Type": "application/json" };

/** ブラウザからのログインを模擬し、Cookie ヘッダーの値（name=value）を返す。 */
async function login(token: string = ADMIN_TOKEN, ip = "203.0.113.10"): Promise<Response> {
  return call("/api/session", {
    method: "POST",
    headers: { ...JSON_HEADERS, Origin: ORIGIN, "CF-Connecting-IP": ip },
    body: JSON.stringify({ token }),
  });
}

async function sessionCookie(): Promise<string> {
  const response = await login();
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("Set-Cookie") ?? "";
  return setCookie.split(";")[0];
}

describe("11. 認証されていない管理操作は拒否される", () => {
  it("一覧・削除は 401（作成はログインなしでも可能だが、管理操作はできない）", async () => {
    await createLinkOk({ url: EXAMPLE_URL, slug: "pk" });

    const list = await call("/api/links");
    expect(list.status).toBe(401);
    expect((await list.json<ErrorBody>()).error.code).toBe("unauthorized");

    const remove = await call("/api/links/pk", { method: "DELETE" });
    expect(remove.status).toBe(401);

    // DB は変更されていない
    expect(await countRows()).toBe(1);
    expect((await call("/pk")).status).toBe(302);
  });

  it("誤ったトークン・壊れた Cookie は 401", async () => {
    expect((await call("/api/links", { headers: bearer("wrong-token-wrong-token") })).status).toBe(401);
    expect((await call("/api/links", { headers: { Authorization: "Basic abc" } })).status).toBe(401);
    expect((await call("/api/links", { headers: { Cookie: "__Host-pks_session=v1.9999999999.AAAA" } })).status).toBe(
      401,
    );
  });

  it("誤ったトークン付きの作成は匿名扱いにせず 401", async () => {
    const response = await createLink({ url: EXAMPLE_URL, slug: "intruder" }, bearer("wrong-token-wrong-token"));
    expect(response.status).toBe(401);
    expect(await countRows()).toBe(0);
  });

  it("ADMIN_TOKEN が未設定なら、管理操作は 503 で拒否する（フェイルクローズ）。作成は可能", async () => {
    for (const ADMIN_TOKEN_VALUE of [undefined, "", "too-short"]) {
      const overrides = { ADMIN_TOKEN: ADMIN_TOKEN_VALUE };
      const list = await call("/api/links", { headers: bearer(ADMIN_TOKEN_VALUE ?? "") }, overrides);
      expect(list.status).toBe(503);
      expect((await list.json<ErrorBody>()).error.code).toBe("auth_not_configured");

      const remove = await call("/api/links/pk", { method: "DELETE" }, overrides);
      expect(remove.status).toBe(503);

      const loginResponse = await call(
        "/api/session",
        { method: "POST", headers: { ...JSON_HEADERS, Origin: ORIGIN }, body: JSON.stringify({ token: "" }) },
        overrides,
      );
      expect(loginResponse.status).toBe(503);

      const session = await call("/api/session", {}, overrides);
      expect(await session.json()).toEqual({ authConfigured: false, authenticated: false, publicCreate: true });
    }
    // 一般の作成は管理トークンの有無に関係なく使える
    const create = await createLink({ url: EXAMPLE_URL }, {}, { ADMIN_TOKEN: undefined });
    expect(create.status).toBe(201);
  });

  it("エラー応答に管理トークンを含めない", async () => {
    const responses = [
      await call("/api/links"),
      await login("wrong-token-wrong-token"),
      await createLink({ url: "javascript:alert(1)" }),
    ];
    for (const response of responses) {
      expect(await response.text()).not.toContain(ADMIN_TOKEN);
    }
  });
});

describe("Bearer トークン認証", () => {
  it("正しいトークンで作成・一覧・削除ができる", async () => {
    expect((await createLink({ url: EXAMPLE_URL, slug: "pk" })).status).toBe(201);
    expect((await call("/api/links", { headers: bearer() })).status).toBe(200);
    expect((await call("/api/links/pk", { method: "DELETE", headers: bearer() })).status).toBe(204);
  });

  it("別オリジンからの要求は Bearer でも 403", async () => {
    const response = await createLink({ url: EXAMPLE_URL }, { ...bearer(), Origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(await countRows()).toBe(0);
  });
});

describe("Cookie セッション", () => {
  it("GET /api/session で認証状態を確認できる", async () => {
    expect(await (await call("/api/session")).json()).toEqual({
      authConfigured: true,
      authenticated: false,
      publicCreate: true,
    });

    const cookie = await sessionCookie();
    const response = await call("/api/session", { headers: { Cookie: cookie } });
    expect(await response.json()).toEqual({ authConfigured: true, authenticated: true, publicCreate: true });
  });

  it("正しいトークンでログインすると安全な属性の Cookie が発行される", async () => {
    const response = await login();
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toMatch(/^__Host-pks_session=v1\.\d+\.[A-Za-z0-9_-]+;/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain(ADMIN_TOKEN);
  });

  it("誤ったトークンではログインできない", async () => {
    const response = await login("wrong-token-wrong-token");
    expect(response.status).toBe(401);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect((await response.json<ErrorBody>()).error.field).toBe("token");
  });

  it("セッション Cookie で一覧・作成・削除ができる（同一オリジン）", async () => {
    const cookie = await sessionCookie();

    const create = await createLink({ url: EXAMPLE_URL, slug: "pk" }, { Cookie: cookie, Origin: ORIGIN });
    expect(create.status).toBe(201);

    const list = await call("/api/links", { headers: { Cookie: cookie } });
    expect(list.status).toBe(200);

    const remove = await call("/api/links/pk", { method: "DELETE", headers: { Cookie: cookie, Origin: ORIGIN } });
    expect(remove.status).toBe(204);
  });

  it("CSRF: Cookie 認証の変更操作は Origin が自オリジンでないと 403", async () => {
    const cookie = await sessionCookie();
    await createLinkOk({ url: EXAMPLE_URL, slug: "pk" });

    const crossOrigin = await createLink({ url: EXAMPLE_URL }, { Cookie: cookie, Origin: "https://evil.example" });
    expect(crossOrigin.status).toBe(403);

    const noOrigin = await createLink({ url: EXAMPLE_URL }, { Cookie: cookie });
    expect(noOrigin.status).toBe(403);

    const crossSite = await call("/api/links/pk", {
      method: "DELETE",
      headers: { Cookie: cookie, "Sec-Fetch-Site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);

    expect(await countRows()).toBe(1);
  });

  it("CSRF: 別オリジンからのログイン要求は 403", async () => {
    const response = await call("/api/session", {
      method: "POST",
      headers: { ...JSON_HEADERS, Origin: "https://evil.example" },
      body: JSON.stringify({ token: ADMIN_TOKEN }),
    });
    expect(response.status).toBe(403);
  });

  it("有効期限切れ・改ざんされたセッションは拒否される", async () => {
    const url = new URL(ORIGIN);
    const expired = (await createSessionCookie(ADMIN_TOKEN, url, Date.now() - 8 * 24 * 60 * 60 * 1000)).split(";")[0];
    expect((await call("/api/links", { headers: { Cookie: expired } })).status).toBe(401);

    const valid = await sessionCookie();
    const [name, value] = valid.split("=");
    const [version, expires, signature] = value.split(".");
    const extended = `${name}=${version}.${Number(expires) + 86400}.${signature}`;
    expect((await call("/api/links", { headers: { Cookie: extended } })).status).toBe(401);
  });

  it("ADMIN_TOKEN を変更すると既存のセッションは無効になる", async () => {
    const cookie = await sessionCookie();
    const response = await call(
      "/api/links",
      { headers: { Cookie: cookie } },
      { ADMIN_TOKEN: "rotated-admin-token-9876543210" },
    );
    expect(response.status).toBe(401);
  });

  it("ログアウトすると Cookie が削除される", async () => {
    const response = await call("/api/session", { method: "DELETE", headers: { Origin: ORIGIN } });
    expect(response.status).toBe(204);
    expect(response.headers.get("Set-Cookie")).toMatch(/^__Host-pks_session=; .*Max-Age=0/);
  });

  it("同一IPからのログイン試行は15分あたり10回まで", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await login("wrong-token-wrong-token", "198.51.100.7")).status).toBe(401);
    }
    const blocked = await login(ADMIN_TOKEN, "198.51.100.7");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Set-Cookie")).toBeNull();

    // 別のIPからは引き続きログインできる
    expect((await login(ADMIN_TOKEN, "198.51.100.8")).status).toBe(200);

    // IP アドレスそのものは保存しない
    const keys = await env.DB.prepare("SELECT key FROM rate_limits WHERE key LIKE 'login:%'").all<{ key: string }>();
    for (const { key } of keys.results) expect(key).not.toContain("198.51.100");
  });
});

describe("ログインなしの作成（公開）", () => {
  const anonymous = { Origin: ORIGIN, "CF-Connecting-IP": "203.0.113.50" };

  it("ログインなしで短縮URLを作成でき、すぐにリダイレクトできる", async () => {
    const auto = await createLink({ url: EXAMPLE_URL }, anonymous);
    expect(auto.status).toBe(201);
    const { link } = await auto.json<{ link: { slug: string; shortUrl: string } }>();
    expect(link.slug).toMatch(/^[2-9a-km-zA-HJ-NP-Z]{8}$/);
    expect((await call(`/${link.slug}`)).headers.get("Location")).toBe(EXAMPLE_URL);

    const custom = await createLink({ url: EXAMPLE_URL, slug: "my-link" }, anonymous);
    expect(custom.status).toBe(201);
  });

  it("Origin ヘッダーがない（curl などの）作成も受け付ける", async () => {
    expect((await createLink({ url: EXAMPLE_URL }, {})).status).toBe(201);
  });

  it("1〜3文字の短縮キーは管理者専用", async () => {
    for (const slug of ["pk", "abc", "x"]) {
      const response = await createLink({ url: EXAMPLE_URL, slug }, anonymous);
      expect(response.status).toBe(400);
      const body = await response.json<ErrorBody>();
      expect(body.error.code).toBe("invalid_slug");
      expect(body.error.message).toContain("管理者専用");
    }
    expect((await createLink({ url: EXAMPLE_URL, slug: "abcd" }, anonymous)).status).toBe(201);
    expect((await createLink({ url: EXAMPLE_URL, slug: "pk" })).status).toBe(201);
  });

  it("既存の短縮URLを上書きできない", async () => {
    await createLinkOk({ url: EXAMPLE_URL, slug: "owner-link" });
    const response = await createLink({ url: "https://example.org/evil", slug: "owner-link" }, anonymous);
    expect(response.status).toBe(409);
    expect((await call("/owner-link")).headers.get("Location")).toBe(EXAMPLE_URL);
  });

  it("別オリジンのページからの作成は 403", async () => {
    const response = await createLink({ url: EXAMPLE_URL }, { Origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(await countRows()).toBe(0);
  });

  it("PUBLIC_CREATE_ENABLED=false で一般の作成を停止でき、管理者は引き続き作成できる", async () => {
    const overrides = { PUBLIC_CREATE_ENABLED: "false" };
    const blocked = await createLink({ url: EXAMPLE_URL }, anonymous, overrides);
    expect(blocked.status).toBe(403);
    expect((await blocked.json<ErrorBody>()).error.code).toBe("public_create_disabled");

    expect((await createLink({ url: EXAMPLE_URL }, bearer(), overrides)).status).toBe(201);

    const session = await call("/api/session", {}, overrides);
    expect(await session.json()).toEqual({ authConfigured: true, authenticated: false, publicCreate: false });
  });
});

describe("ローカル開発（http）", () => {
  it("http では Secure なしの通常名 Cookie を使う", async () => {
    const response = await call("http://localhost:8787/api/session", {
      method: "POST",
      headers: { ...JSON_HEADERS, Origin: "http://localhost:8787" },
      body: JSON.stringify({ token: ADMIN_TOKEN }),
    });
    const setCookie = response.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toMatch(/^pks_session=/);
    expect(setCookie).not.toContain("Secure");

    const cookie = setCookie.split(";")[0];
    const list = await call("http://localhost:8787/api/links", { headers: { Cookie: cookie } });
    expect(list.status).toBe(200);
  });
});
