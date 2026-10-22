import { describe, expect, it } from "vitest";
import { validateDestination } from "../src/destination";
import { escapeHtml } from "../src/http";
import { generateSlug, isValidSlugFormat, validateCustomSlug } from "../src/slug";

describe("generateSlug", () => {
  it("読み間違えにくい文字だけで既定8文字のキーを生成する", () => {
    for (let i = 0; i < 500; i++) {
      const slug = generateSlug();
      expect(slug).toMatch(/^[2-9a-km-zA-HJ-NP-Z]{8}$/);
      expect(isValidSlugFormat(slug)).toBe(true);
    }
  });

  it("十分にばらつく（1000件で重複なし）", () => {
    const slugs = new Set(Array.from({ length: 1000 }, () => generateSlug()));
    expect(slugs.size).toBe(1000);
  });

  it("長さを指定できる", () => {
    expect(generateSlug(12)).toHaveLength(12);
  });
});

describe("validateCustomSlug", () => {
  it.each(["pk", "PK", "a", "my-link_01", "A".repeat(40)])("%s は有効", (slug) => {
    expect(validateCustomSlug(slug)).toEqual({ ok: true, slug });
  });

  it.each(["", "A".repeat(41), "a b", "a/b", "ａｂｃ", "api", "Api", "favicon"])("%s は無効", (slug) => {
    expect(validateCustomSlug(slug).ok).toBe(false);
  });
});

describe("validateDestination", () => {
  const self = "pk-short.example.workers.dev";

  it("正規化した URL を返す", () => {
    expect(validateDestination("HTTPS://Example.COM/Path?A=1", self)).toEqual({
      ok: true,
      url: "https://example.com/Path?A=1",
    });
    expect(validateDestination("https://example.com", self)).toEqual({ ok: true, url: "https://example.com/" });
  });

  it("末尾ドット付きの自ホストも循環として拒否する", () => {
    expect(validateDestination(`https://${self}./x`, self).ok).toBe(false);
  });

  it("国際化ドメインは punycode で保存する", () => {
    expect(validateDestination("https://例え.jp/パス", self)).toEqual({
      ok: true,
      url: "https://xn--r8jz45g.jp/%E3%83%91%E3%82%B9",
    });
  });
});

describe("escapeHtml", () => {
  it("HTML の特殊文字をエスケープする", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });
});
