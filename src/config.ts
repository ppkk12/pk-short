/** 短縮キーの最大長。 */
export const SLUG_MAX_LENGTH = 40;

/** ログインしていない利用者が指定できる短縮キーの最小長（1〜3文字は管理者専用）。 */
export const PUBLIC_SLUG_MIN_LENGTH = 4;

/** 自動生成する短縮キーの長さ。57 種の文字 × 8 桁 ≒ 1.1 × 10^14 通り。 */
export const GENERATED_SLUG_LENGTH = 8;

/** 自動生成キーが衝突した場合の再試行回数。 */
export const GENERATED_SLUG_ATTEMPTS = 5;

/** 転送先URLの最大長。 */
export const DESTINATION_MAX_LENGTH = 2048;

/** これより短い ADMIN_TOKEN は「未設定」とみなして管理操作を拒否する。 */
export const MIN_ADMIN_TOKEN_LENGTH = 16;

/** ログインセッションの有効期間（秒）。 */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

/** 同一IPからのログイン試行の上限。 */
export const LOGIN_LIMIT = { limit: 10, windowSeconds: 15 * 60 } as const;

/** 登録数の既定上限（環境変数で上書き可能）。 */
export const DEFAULT_PUBLIC_CREATE_LIMIT_PER_MINUTE = 10;
export const DEFAULT_PUBLIC_CREATE_LIMIT_PER_DAY = 100;
export const DEFAULT_CREATE_LIMIT_PER_DAY = 5000;

/** IP ごとのレート制限カウンタを削除するまでの期間（秒）と、掃除を行う確率。 */
export const RATE_LIMIT_RETENTION_SECONDS = 60 * 60 * 24 * 2;
export const RATE_LIMIT_CLEANUP_PROBABILITY = 0.05;

/** 一覧APIの1ページあたりの件数。 */
export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 100;

/** JSON リクエストボディの最大サイズ（バイト）。 */
export const MAX_JSON_BODY_BYTES = 8 * 1024;
