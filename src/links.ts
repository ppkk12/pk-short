/** `short_urls` テーブルの行。SQL はすべてバインドパラメータで値を渡す。 */
export interface LinkRow {
  id: number;
  slug: string;
  destination_url: string;
  created_at: string;
  updated_at: string;
  click_count: number;
}

/** API で返す短縮URLの表現。 */
export interface Link {
  id: number;
  slug: string;
  shortUrl: string;
  destinationUrl: string;
  createdAt: string;
  updatedAt: string;
  clickCount: number;
}

const COLUMNS = "id, slug, destination_url, created_at, updated_at, click_count";

export function toLink(row: LinkRow, origin: string): Link {
  return {
    id: row.id,
    slug: row.slug,
    shortUrl: `${origin}/${row.slug}`,
    destinationUrl: row.destination_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    clickCount: row.click_count,
  };
}

/**
 * 短縮URLを登録する。同じ slug が既に存在する場合は既存行を変更せず null を返す
 * （重複は UNIQUE 制約で判定するため、同時登録でも二重登録は起こらない）。
 */
export async function insertLink(db: D1Database, slug: string, destinationUrl: string): Promise<LinkRow | null> {
  return db
    .prepare(
      `INSERT INTO short_urls (slug, destination_url) VALUES (?1, ?2)
       ON CONFLICT (slug) DO NOTHING
       RETURNING ${COLUMNS}`,
    )
    .bind(slug, destinationUrl)
    .first<LinkRow>();
}

export async function findDestination(db: D1Database, slug: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT destination_url FROM short_urls WHERE slug = ?1")
    .bind(slug)
    .first<{ destination_url: string }>();
  return row?.destination_url ?? null;
}

export async function incrementClickCount(db: D1Database, slug: string): Promise<void> {
  await db.prepare("UPDATE short_urls SET click_count = click_count + 1 WHERE slug = ?1").bind(slug).run();
}

/** 新しい順に取得する。cursor には前ページ最後の id を渡す。 */
export async function listLinks(
  db: D1Database,
  options: { cursor: number | null; limit: number },
): Promise<{ rows: LinkRow[]; total: number }> {
  const [page, count] = await db.batch([
    db
      .prepare(`SELECT ${COLUMNS} FROM short_urls WHERE ?1 IS NULL OR id < ?1 ORDER BY id DESC LIMIT ?2`)
      .bind(options.cursor, options.limit),
    db.prepare("SELECT COUNT(*) AS total FROM short_urls"),
  ]);
  return {
    rows: page.results as LinkRow[],
    total: (count.results[0] as { total: number } | undefined)?.total ?? 0,
  };
}

export async function deleteLink(db: D1Database, slug: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM short_urls WHERE slug = ?1").bind(slug).run();
  return result.meta.changes > 0;
}
