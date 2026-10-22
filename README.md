# PK Short

**登録不要・無料**で使える短縮URLサービスです。Cloudflare Workers と D1 の無料枠だけで動きます。

公開中: **https://pk-short.pk-short.workers.dev**

私個人の目的のために作成されたものであり、後悔はしていますが第三者の使用を前提としていないため昨日不十分の可能性があります。
ですので短縮urlをお使いになられるお方は別サイトを推奨します

## 構成

```
.
├── src/
│   ├── index.ts         エントリポイント（API とリダイレクトの振り分け、想定外エラーの処理）
│   ├── api.ts           API（作成・一覧・削除・ログイン）
│   ├── redirect.ts      GET /:slug → 302 リダイレクト、クリック数の加算
│   ├── auth.ts          管理トークン認証・セッション Cookie・CSRF 対策
│   ├── links.ts         D1 へのアクセス（すべてバインドパラメータ）
│   ├── slug.ts          短縮キーの検証・予約語・安全な乱数による生成
│   ├── destination.ts   転送先URLの検証（スキーム・循環・他の短縮サービス）
│   ├── rate-limit.ts    D1 を使った固定ウィンドウのレート制限
│   ├── http.ts          レスポンス生成・セキュリティヘッダー・404/503 ページ
│   ├── config.ts        各種上限値
│   └── env.ts           バインディングと環境変数の型
├── public/              画面（Workers Static Assets で配信）
│   ├── index.html / app.js / styles.css / favicon.svg / robots.txt
│   └── _headers         静的ファイルの CSP などのセキュリティヘッダー
├── migrations/0001_init.sql   D1 スキーマ（ローカル・本番・テスト共通）
├── test/                Vitest（Workers ランタイム上で実行）
├── wrangler.jsonc       Worker / D1 / 静的ファイル / 環境変数の設定
├── vitest.config.ts
├── tsconfig.json        Worker とテストの型チェック
├── tsconfig.client.json 画面の JS（JSDoc）の型チェック
└── .dev.vars.example    ローカル用 Secret のひな形
```

## 仕様

### だれが何をできるか

| 操作 | ログインなし | 管理者 |
| --- | --- | --- |
| 短縮URLの作成 | できる（IP ごとの上限あり） | できる |
| カスタムURLの長さ | 4〜40文字 | 1〜40文字（`/pk` のような短いキーは管理者専用） |
| 自分が作ったURLの確認 | このブラウザの履歴で確認 | すべての短縮URLを一覧で確認 |
| クリック数の確認・削除 | できない | できる |
| 短縮URLへのアクセス（リダイレクト） | 誰でも可能 | 誰でも可能 |

### 短縮キー（カスタムURL）

| 項目 | ルール |
| --- | --- |
| 使用できる文字 | 半角英数字・ハイフン `-`・アンダースコア `_` |
| 長さ | 管理者 1〜40文字、ログインなし 4〜40文字 |
| 大文字と小文字 | **区別する**（`pk` と `PK` は別のキー）。DB の照合順序（BINARY）とも一致 |
| 省略時 | 暗号学的に安全な乱数（`crypto.getRandomValues`）から8文字を自動生成。読み間違えやすい `0 O o 1 l I` を除いた57文字を使用（約 1.1×10¹⁴ 通り） |
| 重複 | `409 Conflict`。既存データは誰も上書きできない（SQL の `UNIQUE` 制約 + `ON CONFLICT DO NOTHING`） |
| 予約語 | `api`, `admin`, `app`, `assets`, `static`, `public`, `index`, `favicon`, `robots`, `styles`, `health`, `healthz`, `status`, `login`, `logout`, `session`, `_headers`, `_redirects`。**予約語の判定だけは大文字小文字を区別しない**（`API` も拒否） |

### 転送先URL

- `http://` と `https://` のみ許可。`javascript:`、`data:`、`file:`、`ftp:`、`mailto:` などは拒否。
- `new URL()` で構文を検証し、正規化した URL（ホスト名の小文字化など）を保存。クエリ文字列・フラグメントはそのまま保持。
- `https://user:pass@...` のような認証情報付きURLは拒否（フィッシング対策）。
- 短縮サービス自身のホスト名へのURLは循環リダイレクトとして拒否。
- bit.ly・x.gd・t.co・tinyurl.com など **他の短縮URLサービスのURLは拒否**（転送先の隠蔽を防ぐため。一覧は `src/destination.ts`）。
- 最大 2048 文字。

### リダイレクト

- `GET /:slug` → D1 を検索し、登録済みの転送先へ `302 Found`（`Cache-Control: private, no-store`）。
- 転送先は DB の値のみ。クエリパラメータなどから指定することはできません。
- 存在しない・書式が不正なキーは `404` ページ（DB を参照しない）。
- `GET` のたびにクリック数を +1（`HEAD` は数えない）。更新はレスポンス返却後に `waitUntil` で行い、失敗してもリダイレクトは成功します。
- DB 障害時は `503` ページを返し、エラー内容はログにのみ出力します。

### API

| メソッド | パス | 認証 | 説明 |
| --- | --- | --- | --- |
| GET | `/api/health` | 不要 | ヘルスチェック |
| GET | `/api/session` | 不要 | `{ authConfigured, authenticated, publicCreate }` |
| POST | `/api/session` | — | `{ "token": "..." }` で管理者ログイン。セッション Cookie を発行 |
| DELETE | `/api/session` | — | ログアウト（Cookie を削除） |
| POST | `/api/links` | 不要 | `{ "url": "...", "slug": "my-link" }`（`slug` は省略可） |
| GET | `/api/links?limit=50&cursor=<id>` | 管理者 | 新しい順の一覧と総件数 |
| DELETE | `/api/links/:slug` | 管理者 | 削除 |
| GET/HEAD | `/:slug` | 不要 | リダイレクト |

エラーは `{ "error": { "code": "...", "message": "...", "field": "url" | "slug" | "token" } }` 形式です。

コマンドラインからの作成例:

```bash
curl -X POST https://pk-short.pk-short.workers.dev/api/links -H "Content-Type: application/json" -d "{\"url\":\"https://example.com/very/long/path\"}"
```

### 悪用対策と上限

誰でも作成できるため、次の上限を設けています（`wrangler.jsonc` の `vars` で変更できます）。

| 変数 | 既定値 | 内容 |
| --- | --- | --- |
| `PUBLIC_CREATE_ENABLED` | `"true"` | `"false"` にするとログインなしの作成を停止（悪用時の緊急停止。管理者は引き続き作成可能） |
| `PUBLIC_CREATE_LIMIT_PER_MINUTE` | `"10"` | ログインなしの作成の、IP ごとの1分あたりの上限 |
| `PUBLIC_CREATE_LIMIT_PER_DAY` | `"100"` | ログインなしの作成の、IP ごとの1日あたりの上限 |
| `CREATE_LIMIT_PER_DAY` | `"5000"` | サービス全体の1日あたりの作成上限（D1 無料枠の保護。管理者にも適用） |

- 上限を超えると `429 Too Many Requests` を返します。
- IP アドレスはそのまま保存せず、SHA-256 のハッシュをカウンタのキーにします。古いカウンタは自動で掃除します。
- 不適切なリンクは管理者がログインして削除できます。

### 管理者の認証とセキュリティ

- 管理トークンは Secret `ADMIN_TOKEN` に設定します（ソースコード・`vars`・クライアント JS には含めません）。
- **`ADMIN_TOKEN` が未設定、または16文字未満の場合は、一覧・削除・ログインをすべて `503` で拒否**します（フェイルクローズ）。作成とリダイレクトは引き続き動作します。
- ブラウザ: 画面右上の「管理」からトークンを入力すると、HMAC-SHA256 で署名した有効期限付き（7日）のセッション Cookie を発行します。
  `HttpOnly` / `SameSite=Strict` / `Path=/`、HTTPS では `Secure` と `__Host-` 接頭辞付き。トークン自体はブラウザに保存しません。
- CLI: `Authorization: Bearer <ADMIN_TOKEN>` でも API を利用できます。誤ったトークンを付けた要求は匿名扱いにせず `401` にします。
- トークン比較は SHA-256 ダイジェストの定数時間比較（`crypto.subtle.timingSafeEqual`）。
- CSRF 対策: 変更系リクエストは `Origin` が自オリジンと一致しないと `403`。Cookie 認証の場合は `Origin` を必須にしています。JSON 以外の `Content-Type` は `415`。
- ログイン試行は同一IPあたり15分で10回まで。
- SQL はすべてバインドパラメータ。DOM へはすべて `textContent` / 属性で挿入し、`innerHTML` は使いません。
- 静的ファイルには `_headers` で CSP（`script-src 'self'` など）・`X-Frame-Options: DENY` 等を付与。
- エラー応答には内部情報（SQL、スタック、トークン）を含めません。
- `ADMIN_TOKEN` を変更すると、発行済みのセッションはすべて無効になります。

## ローカル開発

前提: Node.js 20 以上（動作確認は Node.js 24）。

```bash
npm install
```

ローカル用の管理トークンを用意します（`.dev.vars` は Git に含めません）。

```bash
cp .dev.vars.example .dev.vars
```

`.dev.vars` の `ADMIN_TOKEN` を16文字以上のランダムな値に書き換えます。生成例:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

ローカル D1 にマイグレーションを適用して起動します。

```bash
npm run db:migrate:local
```

```bash
npm run dev
```

http://localhost:8787 を開きます。管理者としてログインするには、右上の「管理」から `.dev.vars` のトークンを入力します。
ローカルのデータは `.wrangler/state` に保存され、再起動後も残ります。

## テスト・型チェック・ビルド

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run build
```

`npm run check` で3つをまとめて実行できます。テストは `@cloudflare/vitest-plugin` により実際の Workers ランタイム（workerd）とローカル D1 上で動き、`migrations/` の SQL をそのまま適用します。`build` は `wrangler deploy --dry-run` で、Cloudflare にはアップロードしません。

## Cloudflare へのデプロイ

無料の Workers / D1 だけで動きます。以下のコマンドはすべて **ご自身のアカウントで** 実行してください。

> このリポジトリの `wrangler.jsonc` には、作者のアカウントで作成した D1 の `database_id` が入っています。
> 自分のアカウントにデプロイする場合は、以下の手順で `database_id` を自分のものに置き換えてください。

1. Cloudflare にログイン（ブラウザが開きます）

   ```bash
   npx wrangler login
   ```

2. D1 データベースを作成（`--location apac` は東アジアからの応答を速くするための指定）

   ```bash
   npx wrangler d1 create pk-short --location apac
   ```

   出力された `database_id` を `wrangler.jsonc` の `d1_databases[0]` に書きます（Wrangler が自動追記を提案した場合は、新しい項目を追加せず既存の `DB` の項目に `database_id` だけを入れてください）。

3. 本番 D1 にマイグレーションを適用

   ```bash
   npm run db:migrate:remote
   ```

4. デプロイ

   ```bash
   npm run deploy
   ```

   出力に表示される `https://pk-short.<サブドメイン>.workers.dev` が公開URLです。
   アカウントに workers.dev サブドメインがない場合は自動で登録されます。
   サブドメインはダッシュボードで変更できますが、**変更すると発行済みの短縮URLはすべて新しいホストに変わり、古いURLは使えなくなります**。

5. 管理トークンを Secret として登録（値は対話入力で、ディスクには残りません。ローカル用とは別の値を推奨）

   ```bash
   npx wrangler secret put ADMIN_TOKEN
   ```

   登録するまでは管理操作が `503` で拒否されます（作成とリダイレクトは動作します）。

`wrangler.jsonc` では `preview_urls: false` としており、バージョンごとのプレビューURLは公開しません。
また、`secrets.required` は指定していません（指定すると初回デプロイ時に Secret をファイルで渡す必要があるため）。

### 独自ドメインを使う場合

`pk.jp` などの独自ドメインを使うには、ドメインを購入して Cloudflare にゾーンとして追加し、
Workers の「Custom Domains」に設定する必要があります（ドメイン代は別途かかります）。
設定後はそのドメインでアクセスすれば、短縮URLも自動的にそのホストで表示されます。

## 無料枠での運用条件

Cloudflare が公表している無料プランの主な上限です（本書作成時点。最新の値は Cloudflare の料金ページで確認してください）。

| サービス | 無料枠 | PK Short での消費 |
| --- | --- | --- |
| Workers リクエスト | 10万件/日 | リダイレクト・API 1回 = 1件。静的ファイル（画面）の配信はカウントされない |
| Workers CPU 時間 | 10ms/リクエスト | 通常の処理は数 ms 程度 |
| D1 読み取り | 500万行/日 | リダイレクト1回 ≒ 1行。管理者の一覧表示は総件数の集計で全行を読む |
| D1 書き込み | 10万行/日 | リダイレクト1回 = 1行（クリック数）、ログインなしの作成1回 ≒ 5行（本体 + レート制限） |
| D1 ストレージ | 5GB | 1件あたり数百バイト程度 |

- 「無制限に作成」と言っても、無料枠には1日あたりの上限があります。全体の作成上限（既定 5000件/日）は、作成とクリックの書き込みが合わせて無料枠に収まるように設定しています。
- 無料プランのまま上限に達しても課金はされず、その日のリクエストやクエリがエラーになります（日次でリセット）。
- `observability`（Workers Logs）を有効にしています。不要なら `wrangler.jsonc` で無効にできます。

## 既知の制限

- クリック数はリンクプレビュー用のクローラーなど、ボットによるアクセスも数えます。
- 「このデバイスの履歴」はブラウザの localStorage にだけ保存されます。ブラウザのデータを消すと履歴も消えます（短縮URL自体は残ります）。
- ログインなしで作成した短縮URLを、作成者が自分で削除することはできません（削除は管理者のみ）。
- セッションはステートレスなため、ログアウトしても盗まれた Cookie を個別に失効させることはできません。全セッションを失効させるには `ADMIN_TOKEN` を変更してください。
- 循環リダイレクトの検出は「現在アクセスされているホスト名」と一致するかで判定します。
- レート制限は D1 上の固定ウィンドウ方式で、厳密な分散レート制限ではありません。大量の IP を使った攻撃には、全体の1日上限と緊急停止スイッチで対応します。
- QRコード、パスワード保護、有効期限、アクセス解析などの x.gd にある機能は未実装です。

## ライセンス

[MIT License](LICENSE)
