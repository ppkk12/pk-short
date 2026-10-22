import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import type { Link } from "../src/links";
import {
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

describe("短縮URLの登録", () => {
  it("1. 有効なURLを登録できる", async () => {
    const response = await createLink({ url: EXAMPLE_URL });
    expect(response.status).toBe(201);

    const { link } = await response.json<{ link: Link }>();
    expect(link.destinationUrl).toBe(EXAMPLE_URL);
    expect(link.shortUrl).toBe(`${ORIGIN}/${link.slug}`);
    expect(link.clickCount).toBe(0);
    expect(link.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("2. 短縮キー pk を指定すると /pk が発行される", async () => {
    const link = await createLinkOk({ url: EXAMPLE_URL, slug: "pk" });
    expect(link.slug).toBe("pk");
    expect(link.shortUrl).toBe(`${ORIGIN}/pk`);
  });

  it("3. 登録後に短縮キーと転送先が DB に保存される", async () => {
    await createLinkOk({ url: EXAMPLE_URL, slug: "pk" });
    const row = await env.DB.prepare("SELECT slug, destination_url, click_count FROM short_urls WHERE slug = ?1")
      .bind("pk")
      .first();
    expect(row).toEqual({ slug: "pk", destination_url: EXAMPLE_URL, click_count: 0 });
  });

  it("5. クエリ文字列・フラグメントを含むURLを正確に保存する", async () => {
    const url = "https://example.com/search?q=%E7%9F%AD%E7%B8%AE&page=2&sort=desc&empty=&tag=a&tag=b#results";
    const link = await createLinkOk({ url, slug: "query" });
    expect(link.destinationUrl).toBe(url);

    const row = await env.DB.prepare("SELECT destination_url FROM short_urls WHERE slug = 'query'").first<{
      destination_url: string;
    }>();
    expect(row?.destination_url).toBe(url);

    const response = await call("/query");
    expect(response.headers.get("Location")).toBe(url);
  });

  it("8. 短縮キーが空欄・省略・空白のみなら安全な乱数から自動生成する", async () => {
    const links = [
      await createLinkOk({ url: EXAMPLE_URL }),
      await createLinkOk({ url: EXAMPLE_URL, slug: "" }),
      await createLinkOk({ url: EXAMPLE_URL, slug: "   " }),
    ];
    for (const link of links) {
      expect(link.slug).toMatch(/^[2-9a-km-zA-HJ-NP-Z]{8}$/);
      expect(link.shortUrl).toBe(`${ORIGIN}/${link.slug}`);
    }
    expect(new Set(links.map((link) => link.slug)).size).toBe(3);
    expect(await countRows()).toBe(3);
  });

  it("前後の空白は除去してから保存する", async () => {
    const link = await createLinkOk({ url: `  ${EXAMPLE_URL}  `, slug: "  trim  " });
    expect(link.slug).toBe("trim");
    expect(link.destinationUrl).toBe(EXAMPLE_URL);
  });

  it("短縮キーは大文字と小文字を区別する", async () => {
    await createLinkOk({ url: "https://example.com/lower", slug: "pk" });
    await createLinkOk({ url: "https://example.com/upper", slug: "PK" });

    expect((await call("/pk")).headers.get("Location")).toBe("https://example.com/lower");
    expect((await call("/PK")).headers.get("Location")).toBe("https://example.com/upper");
  });

  it("40文字の短縮キーは登録でき、41文字は拒否される", async () => {
    const ok = await createLink({ url: EXAMPLE_URL, slug: "a".repeat(40) });
    expect(ok.status).toBe(201);
    const tooLong = await createLink({ url: EXAMPLE_URL, slug: "a".repeat(41) });
    expect(tooLong.status).toBe(400);
  });
});

describe("6. 重複キー", () => {
  it("同じキーは 409 で拒否され、既存レコードは変更されない", async () => {
    const original = await createLinkOk({ url: EXAMPLE_URL, slug: "pk" });

    const response = await createLink({ url: "https://example.org/other", slug: "pk" });
    expect(response.status).toBe(409);
    const body = await response.json<ErrorBody>();
    expect(body.error.code).toBe("slug_taken");
    expect(body.error.field).toBe("slug");

    const rows = await env.DB.prepare("SELECT * FROM short_urls WHERE slug = 'pk'").all();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({
      id: original.id,
      destination_url: EXAMPLE_URL,
      created_at: original.createdAt,
      updated_at: original.updatedAt,
    });
    expect((await call("/pk")).headers.get("Location")).toBe(EXAMPLE_URL);
  });

  it("DB の UNIQUE 制約でも重複が防止されている", async () => {
    await createLinkOk({ url: EXAMPLE_URL, slug: "pk" });
    await expect(
      env.DB.prepare("INSERT INTO short_urls (slug, destination_url) VALUES ('pk', 'https://example.org/')").run(),
    ).rejects.toThrow(/UNIQUE/);
  });
});

describe("7. URL・短縮キーの検証", () => {
  it.each([
    ["空文字", ""],
    ["空白のみ", "   "],
    ["URLでない文字列", "not a url"],
    ["スキームなし", "example.com/path"],
    ["javascript:", "javascript:alert(1)"],
    ["大文字の JAVASCRIPT:", "JAVASCRIPT:alert(document.cookie)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["file:", "file:///etc/passwd"],
    ["ftp:", "ftp://example.com/file.txt"],
    ["mailto:", "mailto:someone@example.com"],
    ["ホストなし", "http://"],
    ["認証情報付き", "https://user:pass@example.com/"],
    ["自身へのURL（循環）", `${ORIGIN}/pk`],
    ["自身へのURL（大文字ホスト）", "https://PK-SHORT.EXAMPLE.WORKERS.DEV/other"],
    ["他の短縮サービス bit.ly", "https://bit.ly/3abcDEF"],
    ["他の短縮サービス x.gd", "https://x.gd/abcd"],
    ["他の短縮サービスのサブドメイン", "https://www.tinyurl.com/xyz"],
    ["長すぎるURL", `https://example.com/${"a".repeat(2100)}`],
    ["文字列以外", 12345],
    ["未指定", undefined],
  ])("%s は 400 で拒否される", async (_label, url) => {
    const response = await createLink({ url, slug: "x" });
    expect(response.status).toBe(400);
    const body = await response.json<ErrorBody>();
    expect(body.error.code).toBe("invalid_url");
    expect(body.error.field).toBe("url");
    expect(body.error.message.length).toBeGreaterThan(0);
    expect(await countRows()).toBe(0);
  });

  it.each([
    ["空白を含む", "p k"],
    ["日本語", "短縮"],
    ["スラッシュ", "a/b"],
    ["ドット", "a.b"],
    ["パーセント", "a%20b"],
    ["予約語 api", "api"],
    ["予約語（大文字）API", "API"],
    ["予約語 health", "health"],
    ["予約語 index", "index"],
  ])("短縮キー: %s は 400 で拒否される", async (_label, slug) => {
    const response = await createLink({ url: EXAMPLE_URL, slug });
    expect(response.status).toBe(400);
    const body = await response.json<ErrorBody>();
    expect(body.error.code).toBe("invalid_slug");
    expect(body.error.field).toBe("slug");
    expect(await countRows()).toBe(0);
  });

  it("短縮キーに文字列以外を指定すると 400", async () => {
    const response = await createLink({ url: EXAMPLE_URL, slug: 123 });
    expect(response.status).toBe(400);
  });

  it("http:// のURLも登録できる", async () => {
    const link = await createLinkOk({ url: "http://example.com/plain", slug: "plain" });
    expect(link.destinationUrl).toBe("http://example.com/plain");
  });

  it("JSON 以外の Content-Type は 415、壊れた JSON は 400", async () => {
    const form = await call("/api/links", {
      method: "POST",
      headers: { ...bearer(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "url=https%3A%2F%2Fexample.com",
    });
    expect(form.status).toBe(415);

    const broken = await call("/api/links", {
      method: "POST",
      headers: { ...bearer(), "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(broken.status).toBe(400);
    expect((await broken.json<ErrorBody>()).error.code).toBe("invalid_json");
  });
});

describe("リダイレクト", () => {
  it("4. /pk にアクセスすると登録先へ 302 リダイレクトする", async () => {
    await createLinkOk({ url: EXAMPLE_URL, slug: "pk" });

    const response = await call("/pk");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(EXAMPLE_URL);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("リダイレクトは認証なしで利用できる", async () => {
    await createLinkOk({ url: EXAMPLE_URL, slug: "pk" });
    const response = await call("/pk", { headers: { Cookie: "pks_session=garbage" } });
    expect(response.status).toBe(302);
  });

  it("転送先をリクエストパラメータで指定することはできない", async () => {
    await createLinkOk({ url: EXAMPLE_URL, slug: "pk" });
    const response = await call("/pk?url=https://evil.example/&to=https://evil.example/");
    expect(response.headers.get("Location")).toBe(EXAMPLE_URL);
  });

  it("9. 存在しないキーは 404 ページを返す", async () => {
    const response = await call("/missing");
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(await response.text()).toContain("リンクが見つかりません");
  });

  it.each(["/a.b", "/%3Cscript%3Ealert(1)%3C%2Fscript%3E", `/${"a".repeat(41)}`, "/pk/extra", "/..%2Fapi", "/"])(
    "不正なキー %s は DB を参照せず安全に 404 を返す",
    async (path) => {
      await createLinkOk({ url: EXAMPLE_URL, slug: "pk" });
      const response = await call(path);
      expect(response.status).toBe(404);
      const html = await response.text();
      expect(html).not.toContain("<script>");
    },
  );

  it("GET / HEAD 以外のメソッドは 405", async () => {
    await createLinkOk({ url: EXAMPLE_URL, slug: "pk" });
    const response = await call("/pk", { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD");
  });

  it("10. アクセスするたびにクリック数が増える（HEAD は数えない）", async () => {
    await createLinkOk({ url: EXAMPLE_URL, slug: "pk" });

    await call("/pk");
    await call("/pk");
    await call("/pk");
    await call("/pk", { method: "HEAD" });
    await call("/missing");

    const row = await env.DB.prepare("SELECT click_count FROM short_urls WHERE slug = 'pk'").first<{
      click_count: number;
    }>();
    expect(row?.click_count).toBe(3);

    const list = await call("/api/links", { headers: bearer() });
    const { links } = await list.json<{ links: Link[] }>();
    expect(links[0].clickCount).toBe(3);
  });

  it("クリック数の更新に失敗してもリダイレクトは成功する", async () => {
    await createLinkOk({ url: EXAMPLE_URL, slug: "pk" });
    const failingWrites = {
      prepare(sql: string) {
        if (sql.trimStart().startsWith("UPDATE")) throw new Error("D1_ERROR: write failed");
        return env.DB.prepare(sql);
      },
    } as unknown as D1Database;

    const response = await call("/pk", {}, { DB: failingWrites });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(EXAMPLE_URL);
  });

  it("DB 障害時は 503 を返し、内部情報を表示しない", async () => {
    const brokenDb = {
      prepare() {
        throw new Error("D1_ERROR: no such table: short_urls SECRET_INTERNAL_DETAIL");
      },
    } as unknown as D1Database;

    const page = await call("/pk", {}, { DB: brokenDb });
    expect(page.status).toBe(503);
    const html = await page.text();
    expect(html).not.toMatch(/D1_ERROR|SECRET_INTERNAL_DETAIL|short_urls/);

    const api = await call("/api/links", { headers: bearer() }, { DB: brokenDb });
    expect(api.status).toBe(500);
    const text = await api.text();
    expect(text).not.toMatch(/D1_ERROR|SECRET_INTERNAL_DETAIL|short_urls/);
    expect(JSON.parse(text).error.code).toBe("internal_error");
  });
});

describe("12. 削除", () => {
  it("DELETE で削除すると DB から消え、短縮URLは 404 になる", async () => {
    await createLinkOk({ url: EXAMPLE_URL, slug: "pk" });
    await createLinkOk({ url: EXAMPLE_URL, slug: "keep" });

    const response = await call("/api/links/pk", { method: "DELETE", headers: bearer() });
    expect(response.status).toBe(204);

    expect(await env.DB.prepare("SELECT 1 FROM short_urls WHERE slug = 'pk'").first()).toBeNull();
    expect(await countRows()).toBe(1);
    expect((await call("/pk")).status).toBe(404);
    expect((await call("/keep")).status).toBe(302);
  });

  it("存在しない・不正なキーの削除は 404", async () => {
    expect((await call("/api/links/missing", { method: "DELETE", headers: bearer() })).status).toBe(404);
    expect((await call("/api/links/a.b", { method: "DELETE", headers: bearer() })).status).toBe(404);
    expect((await call("/api/links/%E0%A4%A", { method: "DELETE", headers: bearer() })).status).toBe(404);
  });

  it("削除後は同じキーを再登録できる", async () => {
    await createLinkOk({ url: EXAMPLE_URL, slug: "pk" });
    await call("/api/links/pk", { method: "DELETE", headers: bearer() });
    const link = await createLinkOk({ url: "https://example.org/new", slug: "pk" });
    expect((await call("/pk")).headers.get("Location")).toBe(link.destinationUrl);
  });

  it("削除は DELETE メソッドのみ受け付ける", async () => {
    await createLinkOk({ url: EXAMPLE_URL, slug: "pk" });
    const response = await call("/api/links/pk", { method: "POST", headers: bearer() });
    expect(response.status).toBe(405);
    expect(await countRows()).toBe(1);
  });
});

describe("一覧", () => {
  it("新しい順に返し、総件数とページングを提供する", async () => {
    await createLinkOk({ url: "https://example.com/1", slug: "one" });
    await createLinkOk({ url: "https://example.com/2", slug: "two" });
    await createLinkOk({ url: "https://example.com/3", slug: "three" });

    const first = await call("/api/links?limit=2", { headers: bearer() });
    expect(first.status).toBe(200);
    const page1 = await first.json<{ links: Link[]; total: number; nextCursor: number | null }>();
    expect(page1.total).toBe(3);
    expect(page1.links.map((link) => link.slug)).toEqual(["three", "two"]);
    expect(page1.links[0].shortUrl).toBe(`${ORIGIN}/three`);
    expect(page1.nextCursor).not.toBeNull();

    const second = await call(`/api/links?limit=2&cursor=${page1.nextCursor}`, { headers: bearer() });
    const page2 = await second.json<{ links: Link[]; nextCursor: number | null }>();
    expect(page2.links.map((link) => link.slug)).toEqual(["one"]);
    expect(page2.nextCursor).toBeNull();
  });

  it("データがなければ空配列を返す", async () => {
    const response = await call("/api/links", { headers: bearer() });
    expect(await response.json()).toEqual({ links: [], total: 0, nextCursor: null });
  });

  it("不正な cursor は 400", async () => {
    const response = await call("/api/links?cursor=abc", { headers: bearer() });
    expect(response.status).toBe(400);
  });
});

describe("連続登録の制限", () => {
  const anonymous = (ip: string) => ({ "CF-Connecting-IP": ip });

  it("ログインなしの作成は IP ごとに1分あたりの上限があり、超えると 429", async () => {
    const overrides: Partial<Env> = { PUBLIC_CREATE_LIMIT_PER_MINUTE: "3" };
    for (let i = 0; i < 3; i++) {
      expect((await createLink({ url: EXAMPLE_URL }, anonymous("192.0.2.1"), overrides)).status).toBe(201);
    }
    const limited = await createLink({ url: EXAMPLE_URL }, anonymous("192.0.2.1"), overrides);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");

    // 別の IP や管理者は影響を受けない
    expect((await createLink({ url: EXAMPLE_URL }, anonymous("192.0.2.2"), overrides)).status).toBe(201);
    expect((await createLink({ url: EXAMPLE_URL }, bearer(), overrides)).status).toBe(201);
    expect(await countRows()).toBe(5);
  });

  it("ログインなしの作成は IP ごとに1日あたりの上限がある", async () => {
    const overrides: Partial<Env> = { PUBLIC_CREATE_LIMIT_PER_DAY: "2" };
    expect((await createLink({ url: EXAMPLE_URL }, anonymous("192.0.2.3"), overrides)).status).toBe(201);
    expect((await createLink({ url: EXAMPLE_URL }, anonymous("192.0.2.3"), overrides)).status).toBe(201);
    expect((await createLink({ url: EXAMPLE_URL }, anonymous("192.0.2.3"), overrides)).status).toBe(429);
  });

  it("サービス全体の1日上限は管理者にも適用される（無料枠の保護）", async () => {
    const overrides: Partial<Env> = { CREATE_LIMIT_PER_DAY: "2" };
    expect((await createLink({ url: EXAMPLE_URL }, anonymous("192.0.2.4"), overrides)).status).toBe(201);
    expect((await createLink({ url: EXAMPLE_URL }, bearer(), overrides)).status).toBe(201);
    expect((await createLink({ url: EXAMPLE_URL }, bearer(), overrides)).status).toBe(429);
    expect(await countRows()).toBe(2);
  });

  it("IP アドレスそのものはレート制限の記録に残さない", async () => {
    await createLink({ url: EXAMPLE_URL }, anonymous("192.0.2.5"));
    const keys = await env.DB.prepare("SELECT key FROM rate_limits").all<{ key: string }>();
    expect(keys.results.length).toBeGreaterThan(0);
    for (const { key } of keys.results) expect(key).not.toContain("192.0.2");
  });

  it("既定の上限値は wrangler.jsonc の vars から読み込まれる", () => {
    expect(env.PUBLIC_CREATE_ENABLED).toBe("true");
    expect(env.PUBLIC_CREATE_LIMIT_PER_MINUTE).toBe("10");
    expect(env.PUBLIC_CREATE_LIMIT_PER_DAY).toBe("100");
    expect(env.CREATE_LIMIT_PER_DAY).toBe("5000");
  });
});

describe("その他の公開エンドポイント", () => {
  it("ヘルスチェックは認証なしで 200", async () => {
    const response = await call("/api/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("未定義の API は 404 JSON", async () => {
    const response = await call("/api/unknown", { headers: bearer() });
    expect(response.status).toBe(404);
    expect((await response.json<ErrorBody>()).error.code).toBe("not_found");
  });
});
