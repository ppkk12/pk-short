export interface RateLimitRule {
  /** カウンタの識別子（例: `create:day`, `ip:min:<IPのハッシュ>`）。 */
  key: string;
  /** ウィンドウ内で許可する回数。 */
  limit: number;
  /** ウィンドウの長さ（秒）。 */
  windowSeconds: number;
}

export interface RateLimitCleanup {
  /** この接頭辞で始まるキーのうち、古いウィンドウの行を削除する。 */
  keyPrefix: string;
  olderThanSeconds: number;
}

/**
 * 固定ウィンドウ方式のレート制限。すべてのルールのカウンタを1回の D1 バッチで加算し、
 * いずれかが上限を超えていれば false を返す。
 */
export async function consumeRateLimits(
  db: D1Database,
  rules: RateLimitRule[],
  nowMs: number = Date.now(),
  cleanup?: RateLimitCleanup,
): Promise<boolean> {
  const nowSeconds = Math.floor(nowMs / 1000);
  const statements = rules.map((rule) =>
    db
      .prepare(
        `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
         ON CONFLICT (key) DO UPDATE SET
           count = CASE WHEN rate_limits.window_start = excluded.window_start
                        THEN rate_limits.count + 1 ELSE 1 END,
           window_start = excluded.window_start
         RETURNING count`,
      )
      .bind(rule.key, nowSeconds - (nowSeconds % rule.windowSeconds)),
  );
  if (cleanup) {
    // IP ごとのカウンタが溜まり続けないよう、古いウィンドウの行を同じバッチで削除する。
    // 接頭辞の範囲指定にすることで主キーのインデックスを使える。
    statements.push(
      db
        .prepare("DELETE FROM rate_limits WHERE key >= ?1 AND key < ?2 AND window_start < ?3")
        .bind(cleanup.keyPrefix, `${cleanup.keyPrefix}￿`, nowSeconds - cleanup.olderThanSeconds),
    );
  }

  const results = await db.batch<{ count: number }>(statements);
  return rules.every((rule, index) => (results[index].results[0]?.count ?? 0) <= rule.limit);
}

/** レート制限用のクライアント識別子。IP アドレスそのものは保存せず、用途別のハッシュにする。 */
export async function hashClientIp(request: Request, purpose: string): Promise<string> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`pk-short/${purpose}/${ip}`));
  return Array.from(new Uint8Array(digest).slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
