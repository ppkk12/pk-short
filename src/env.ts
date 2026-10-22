/** Worker に渡されるバインディングと環境変数。 */
export interface Env {
  /** 短縮URLを保存する D1 データベース。 */
  DB: D1Database;
  /**
   * 管理操作（一覧・削除）用のトークン。必ず Secret として設定する。
   * 未設定、または短すぎる場合は管理APIをすべて拒否する（フェイルクローズ）。
   */
  ADMIN_TOKEN?: string;
  /** ログインなしの短縮URL作成を許可するか（"false" で停止。既定は許可）。 */
  PUBLIC_CREATE_ENABLED?: string;
  /** ログインなしの作成の、IP ごとの 1 分あたりの上限。 */
  PUBLIC_CREATE_LIMIT_PER_MINUTE?: string;
  /** ログインなしの作成の、IP ごとの 1 日あたりの上限。 */
  PUBLIC_CREATE_LIMIT_PER_DAY?: string;
  /** サービス全体の 1 日あたりの作成上限（無料枠を守るための上限）。 */
  CREATE_LIMIT_PER_DAY?: string;
}
