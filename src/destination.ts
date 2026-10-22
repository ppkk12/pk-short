import { DESTINATION_MAX_LENGTH } from "./config";

export type DestinationCheck = { ok: true; url: string } | { ok: false; message: string };

const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/**
 * 他の短縮URLサービス。短縮URLを多重に重ねると最終的な転送先が分かりにくくなり、
 * 悪用（フィッシング先の隠蔽）に使われやすいため登録を拒否する。サブドメインも対象。
 */
const BLOCKED_HOSTS: readonly string[] = [
  "bit.ly",
  "bitly.com",
  "t.co",
  "tinyurl.com",
  "x.gd",
  "is.gd",
  "v.gd",
  "goo.gl",
  "ow.ly",
  "buff.ly",
  "rebrand.ly",
  "cutt.ly",
  "shorturl.at",
  "rb.gy",
  "tiny.cc",
  "t.ly",
  "s.id",
  "lnkd.in",
  "bl.ink",
  "shorturl.asia",
];

/**
 * 転送先URLを検証し、正規化した URL 文字列を返す。
 * http / https 以外のスキーム（javascript:, data:, file: など）、認証情報付きURL、
 * 短縮サービス自身へのURL（循環リダイレクト）は拒否する。
 *
 * @param selfHostname 短縮サービス自身のホスト名（リクエストURLから取得）
 */
export function validateDestination(input: unknown, selfHostname: string): DestinationCheck {
  if (typeof input !== "string" || input.trim() === "") {
    return { ok: false, message: "短縮したいURLを入力してください。" };
  }
  const raw = input.trim();
  if (raw.length > DESTINATION_MAX_LENGTH) {
    return { ok: false, message: `URLが長すぎます（${DESTINATION_MAX_LENGTH}文字まで）。` };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      ok: false,
      message: "URLの形式が正しくありません。https:// から始まる完全なURLを入力してください。",
    };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { ok: false, message: "http:// または https:// で始まるURLのみ登録できます。" };
  }
  if (url.hostname === "") {
    return { ok: false, message: "URLにホスト名が含まれていません。" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, message: "ユーザー名やパスワードを含むURLは登録できません。" };
  }
  const hostname = normalizeHostname(url.hostname);
  if (hostname === normalizeHostname(selfHostname)) {
    return {
      ok: false,
      message: "PK Short 自身のURLは転送先に指定できません（循環リダイレクトになります）。",
    };
  }
  if (BLOCKED_HOSTS.some((blocked) => hostname === blocked || hostname.endsWith(`.${blocked}`))) {
    return { ok: false, message: "他の短縮URLサービスのURLは登録できません。元のURLを入力してください。" };
  }

  // 正規化（ホスト名の小文字化や空白のエンコード）後の長さも DB 制約に収まるか確認する。
  if (url.href.length > DESTINATION_MAX_LENGTH) {
    return { ok: false, message: `URLが長すぎます（${DESTINATION_MAX_LENGTH}文字まで）。` };
  }
  return { ok: true, url: url.href };
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}
