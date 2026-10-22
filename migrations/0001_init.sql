-- PK Short 初期スキーマ
-- ローカル（--local）と本番（--remote）で同じファイルを適用する。

-- 短縮URL本体。
-- slug は大文字・小文字を区別する（SQLite の既定照合順序 BINARY）。
-- UNIQUE 制約により重複キーは DB レベルで拒否され、自動でインデックスが作られる。
-- 一覧は id の降順（= 作成順）で取得するため、追加のインデックスは不要。
CREATE TABLE IF NOT EXISTS short_urls (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT    NOT NULL UNIQUE
                  CHECK (length(slug) BETWEEN 1 AND 40 AND slug NOT GLOB '*[^A-Za-z0-9_-]*'),
  destination_url TEXT    NOT NULL
                  CHECK (length(destination_url) <= 2048),
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  click_count     INTEGER NOT NULL DEFAULT 0 CHECK (click_count >= 0)
);

-- 固定ウィンドウ方式のレート制限カウンタ（登録・ログイン試行の連続実行を抑止する）。
CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT    PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);
