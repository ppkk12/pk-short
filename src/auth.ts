import { MIN_ADMIN_TOKEN_LENGTH, SESSION_TTL_SECONDS } from "./config";
import type { Env } from "./env";

/**
 * 管理者認証。
 *
 * - ブラウザ: `POST /api/session` でトークンを送ると、HMAC 署名付きの HttpOnly / SameSite=Strict
 *   Cookie を発行する。トークン自体はクライアントに保存しない。
 * - CLI 等: `Authorization: Bearer <ADMIN_TOKEN>` でも認証できる。
 *
 * セッションはステートレス（有効期限 + 署名）で、ADMIN_TOKEN を変更すると全セッションが無効になる。
 */

const SESSION_VERSION = "v1";
const encoder = new TextEncoder();

export type AuthMethod = "bearer" | "session";

/** 有効な管理トークンを返す。未設定・短すぎる場合は null（= 管理操作をすべて拒否）。 */
export function getAdminToken(env: Env): string | null {
  const token = env.ADMIN_TOKEN?.trim() ?? "";
  return token.length >= MIN_ADMIN_TOKEN_LENGTH ? token : null;
}

/** 長さに依存しない定数時間比較（両者を SHA-256 にしてから比較する）。 */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(hashA, hashB);
}

/** リクエストの認証方式を判定する。認証できなければ null。 */
export async function authenticate(
  request: Request,
  token: string,
  url: URL,
  nowMs: number = Date.now(),
): Promise<AuthMethod | null> {
  const authorization = request.headers.get("Authorization");
  if (authorization !== null) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    return match && (await safeEqual(match[1].trim(), token)) ? "bearer" : null;
  }
  const cookie = readCookie(request, sessionCookieName(url));
  if (cookie !== null && (await verifySessionValue(cookie, token, nowMs))) {
    return "session";
  }
  return null;
}

/**
 * CSRF 対策。状態を変更するリクエストについて、別オリジンから送られたものを拒否する。
 * Cookie で認証する場合は Origin ヘッダーが自オリジンと一致することを必須にする
 * （ブラウザは fetch の POST / DELETE で必ず Origin を送る）。
 */
export function isTrustedOrigin(request: Request, url: URL, requireOrigin: boolean): boolean {
  const origin = request.headers.get("Origin");
  if (origin !== null) return origin === url.origin;
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  return !requireOrigin;
}

/** `https` では `__Host-` 接頭辞付き（Secure 必須）、ローカル開発の `http` では通常名を使う。 */
export function sessionCookieName(url: URL): string {
  return url.protocol === "https:" ? "__Host-pks_session" : "pks_session";
}

/**
 * 有効期限と HMAC 署名が付与されたセッション Cookie 文字列を生成する。
 */
export async function createSessionCookie(token: string, url: URL, nowMs: number = Date.now()): Promise<string> {
  const expires = Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS;
  const payload = `${SESSION_VERSION}.${expires}`;
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(token), encoder.encode(signingInput(payload)));
  const value = `${payload}.${toBase64Url(new Uint8Array(signature))}`;
  return serializeCookie(sessionCookieName(url), value, url, SESSION_TTL_SECONDS);
}

export function clearSessionCookie(url: URL): string {
  return serializeCookie(sessionCookieName(url), "", url, 0);
}

/**
 * セッション値の構造、有効期限、署名を検証する。
 */
async function verifySessionValue(value: string, token: string, nowMs: number): Promise<boolean> {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== SESSION_VERSION || !/^\d{1,12}$/.test(parts[1])) return false;
  const expires = Number(parts[1]);
  if (expires * 1000 <= nowMs) return false;
  const signature = fromBase64Url(parts[2]);
  if (signature === null) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  return crypto.subtle.verify("HMAC", await hmacKey(token), signature, encoder.encode(signingInput(payload)));
}

function signingInput(payload: string): string {
  return `pk-short/session/${payload}`;
}

function hmacKey(token: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(token), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

function serializeCookie(name: string, value: string, url: URL, maxAge: number): string {
  const attributes = [`${name}=${value}`, "Path=/", `Max-Age=${maxAge}`, "HttpOnly", "SameSite=Strict"];
  if (url.protocol === "https:") attributes.push("Secure");
  return attributes.join("; ");
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}
