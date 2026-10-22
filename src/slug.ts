import { GENERATED_SLUG_LENGTH, SLUG_MAX_LENGTH } from "./config";

/**
 * 短縮キーの書式。英数字・ハイフン・アンダースコアのみ、1〜40文字。
 * 大文字と小文字は区別する（`pk` と `PK` は別のキー）。DB の照合順序（BINARY）とも一致する。
 */
const SLUG_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * 予約パス。管理画面・API・静的ファイル・ヘルスチェックと衝突しないよう登録を拒否する。
 * 予約語の判定だけは大文字・小文字を区別しない（`API` や `Health` も紛らわしいため拒否）。
 */
const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "api",
  "admin",
  "app",
  "assets",
  "static",
  "public",
  "index",
  "favicon",
  "robots",
  "styles",
  "health",
  "healthz",
  "status",
  "login",
  "logout",
  "session",
  "_headers",
  "_redirects",
]);

/** 読み間違えやすい 0/O/o, 1/l/I を除いた 57 文字。 */
const GENERATED_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";

export type SlugCheck = { ok: true; slug: string } | { ok: false; message: string };

/** 書式だけを確認する（リダイレクト・削除時の入力チェック用）。 */
export function isValidSlugFormat(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

export function isReservedSlug(value: string): boolean {
  return RESERVED_SLUGS.has(value.toLowerCase());
}

/**
 * ユーザーが指定した短縮キーを検証する。前後の空白は呼び出し側で除去しておくこと。
 * minLength はログインしていない利用者のとき PUBLIC_SLUG_MIN_LENGTH を渡す。
 */
export function validateCustomSlug(value: string, minLength = 1): SlugCheck {
  if (value.length > SLUG_MAX_LENGTH || value.length === 0) {
    return { ok: false, message: `短縮キーは${minLength}〜${SLUG_MAX_LENGTH}文字で指定してください。` };
  }
  if (!SLUG_PATTERN.test(value)) {
    return {
      ok: false,
      message: "短縮キーに使えるのは半角英数字・ハイフン（-）・アンダースコア（_）のみです。",
    };
  }
  if (isReservedSlug(value)) {
    return { ok: false, message: `「${value}」はシステムで予約されているため使用できません。` };
  }
  if (value.length < minLength) {
    return {
      ok: false,
      message: `短縮キーは${minLength}〜${SLUG_MAX_LENGTH}文字で指定してください（${minLength - 1}文字以下は管理者専用です）。`,
    };
  }
  return { ok: true, slug: value };
}

/** 暗号学的に安全な乱数から短縮キーを生成する（剰余の偏りは棄却サンプリングで除去）。 */
export function generateSlug(length: number = GENERATED_SLUG_LENGTH): string {
  const alphabetSize = GENERATED_ALPHABET.length;
  const unbiasedLimit = 256 - (256 % alphabetSize);
  let slug = "";
  while (slug.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const byte of bytes) {
      if (byte >= unbiasedLimit) continue;
      slug += GENERATED_ALPHABET[byte % alphabetSize];
      if (slug.length === length) break;
    }
  }
  return slug;
}
