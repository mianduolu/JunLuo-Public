import type { SQLiteDatabase } from 'expo-sqlite';

// Local arrival receipts only; no text copy, generic queue or cross-device schema.
export const POST_NOTIFICATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS baiyun_post_notification_arrivals (
  post_id TEXT NOT NULL, source TEXT NOT NULL, group_key TEXT NOT NULL,
  background INTEGER NOT NULL, PRIMARY KEY (post_id, source)
);
CREATE TRIGGER IF NOT EXISTS baiyun_post_notification_delete AFTER DELETE ON memories
BEGIN DELETE FROM baiyun_post_notification_arrivals WHERE post_id = OLD.id; END;
CREATE TRIGGER IF NOT EXISTS baiyun_post_notification_comment_delete AFTER DELETE ON memory_comments
BEGIN DELETE FROM baiyun_post_notification_arrivals WHERE post_id = OLD.memory_id AND source = OLD.source
  AND NOT EXISTS (SELECT 1 FROM baiyun_post_comment_metadata c JOIN memory_comments b ON b.id = c.current_id
    WHERE c.post_id = OLD.memory_id AND c.source = OLD.source AND c.deleted = 0); END;
`;

export async function recordPostNotificationArrival(database: SQLiteDatabase, postId: string,
  source: string, groupKey: string, background: boolean) {
  await database.runAsync(`INSERT OR IGNORE INTO baiyun_post_notification_arrivals
    (post_id, source, group_key, background) VALUES (?, ?, ?, ?)`, postId, source, groupKey, background ? 1 : 0);
}

export type PostNotificationArrival = {
  postId: string; commentSource: string | null; createdAt: number; updatedAt: number;
  groupKey: string; background: number; content: string; title: string | null;
};

export function loadPostNotificationArrivals(database: SQLiteDatabase) {
  return database.getAllAsync<PostNotificationArrival>(`SELECT a.post_id AS postId,
    NULL AS commentSource, m.created_at AS createdAt, m.updated_at AS updatedAt,
    a.group_key AS groupKey, a.background AS background, m.content, COALESCE(p.title, m.title) AS title
    FROM baiyun_post_notification_arrivals a JOIN memories m ON m.id = a.post_id
    JOIN baiyun_post_metadata p ON p.post_id = a.post_id
    WHERE a.source = '' AND p.author = 'I' AND m.type <> 'archived'
    UNION ALL
    SELECT a.post_id AS postId, a.source AS commentSource, c.created_at AS createdAt,
    c.updated_at AS updatedAt, a.group_key AS groupKey, a.background AS background, body.content, NULL AS title
    FROM baiyun_post_notification_arrivals a JOIN baiyun_post_comment_metadata c
    ON c.post_id = a.post_id AND c.source = a.source
    JOIN memory_comments body ON body.id = c.current_id AND body.memory_id = c.post_id
    JOIN memories m ON m.id = a.post_id
    WHERE a.source <> '' AND c.author = 'I' AND c.deleted = 0 AND m.type <> 'archived'
    ORDER BY createdAt ASC, postId, commentSource`);
}
