import { getMemoryRecordEntitySpec } from './syncMemoryRecords';
import { POST_IMAGE_SCHEMA_SQL } from '../posts/baiyunPostImageData';
import type { SyncOperation } from './syncProtocol';

const columns = (kind: string) => Object.keys(getMemoryRecordEntitySpec(kind)!.fields);
const rowJson = (kind: string, alias: string, canonicalAuthor = false) => `json_object(${columns(kind)
  .map(field => `'${field}', ${canonicalAuthor && field === 'author'
    ? `CASE WHEN ${alias}.author IN ('you', '小仓鼠') THEN 'you' ELSE 'I' END` : `${alias}.${field}`}`).join(', ')})`;

const imageAssets = (alias: string) => `(SELECT COALESCE(json_group_array(json(asset)), '[]') FROM (
  SELECT json_object('id', i.id, 'width', i.width, 'height', i.height, 'byte_size', i.byte_size,
    'object_id', i.object_id, 'chunk_count', i.chunk_count) AS asset
  FROM json_each(${alias}.image_group_json, '$.imageIds') j JOIN baiyun_post_images i ON i.id = j.value
  ORDER BY CAST(j.key AS INTEGER)))`;
const imageDescription = (alias: string, comment: boolean) => `(SELECT v.description FROM baiyun_post_image_vision v
  WHERE v.post_id = ${alias}.post_id AND ${comment ? `v.comment_source = ${alias}.source` : 'v.comment_source IS NULL'}
    AND v.group_key = json_array(json_extract(${alias}.image_group_json, '$.id'),
      json_extract(${alias}.image_group_json, '$.version'), json(json_extract(${alias}.image_group_json, '$.imageIds')))
    AND length(trim(v.description)) > 0)`;

// Reuse native image tables and computed views. Draft references and paid-call
// execution state remain local; only completed, group-matching descriptions travel.
export const POST_TAGS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS baiyun_post_tags (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('I', 'you', 'both')),
  merged_into_id TEXT, merged_at INTEGER,
  updated_at INTEGER NOT NULL DEFAULT 0, version_id TEXT NOT NULL DEFAULT 'legacy'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_baiyun_post_tags_active_name
  ON baiyun_post_tags(name) WHERE merged_into_id IS NULL;
`;

/** Rebuild only the existing table when its old inline UNIQUE blocks hidden aliases. */
export function buildBaiyunPostTagUpgradeSql(columns: readonly string[], tableSql = '') {
  if (!columns.length) return '';
  const names = new Set(columns);
  const fields = ['id', 'name', 'scope', 'merged_into_id', 'merged_at', 'updated_at', 'version_id'];
  const inlineUnique = /\bname\s+TEXT[^,]*\bUNIQUE\b|\bUNIQUE\s*\(\s*name\s*\)/i.test(tableSql);
  if (fields.every(field => names.has(field)) && !inlineUnique) return '';
  for (const field of ['id', 'name', 'scope']) if (!names.has(field)) throw new Error('post tag upgrade 缺少原始字段。');
  const values = fields.map(field => names.has(field)
    ? field === 'version_id' ? "COALESCE(NULLIF(trim(version_id), ''), 'legacy:' || id)"
      : field === 'updated_at' ? 'COALESCE(updated_at, 0)' : field
    : field === 'version_id' ? "'legacy:' || id" : field === 'updated_at' ? '0' : 'NULL');
  return `
    DROP TRIGGER IF EXISTS memory_sync_capture_baiyun_post_tags_insert;
    DROP TRIGGER IF EXISTS memory_sync_capture_baiyun_post_tags_update;
    DROP TRIGGER IF EXISTS memory_sync_capture_baiyun_post_tags_delete;
    ${POST_TAGS_SCHEMA_SQL.slice(0, POST_TAGS_SCHEMA_SQL.indexOf('CREATE UNIQUE INDEX'))
      .replace('IF NOT EXISTS baiyun_post_tags', 'baiyun_post_tags_upgrade')}
    INSERT INTO baiyun_post_tags_upgrade (${fields.join(', ')})
      SELECT ${values.join(', ')} FROM baiyun_post_tags ORDER BY rowid;
    DROP TABLE baiyun_post_tags;
    ALTER TABLE baiyun_post_tags_upgrade RENAME TO baiyun_post_tags;
    CREATE UNIQUE INDEX idx_baiyun_post_tags_active_name
      ON baiyun_post_tags(name) WHERE merged_into_id IS NULL;
  `;
}

export const POST_SYNC_BASE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS baiyun_post_metadata (
  post_id TEXT PRIMARY KEY NOT NULL, author TEXT NOT NULL CHECK (author IN ('I', 'you')),
  tag_ids_json TEXT NOT NULL DEFAULT '[]', image_group_json TEXT, title TEXT
);
CREATE TABLE IF NOT EXISTS baiyun_post_comment_metadata (
  post_id TEXT NOT NULL, source TEXT NOT NULL, current_id TEXT,
  author TEXT NOT NULL CHECK (author IN ('I', 'you')), created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  image_group_json TEXT, PRIMARY KEY (post_id, source)
);
CREATE TABLE IF NOT EXISTS baiyun_post_content_versions (post_id TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL);
${POST_TAGS_SCHEMA_SQL}
CREATE TABLE IF NOT EXISTS baiyun_post_tag_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1), seeded INTEGER NOT NULL CHECK (seeded = 1)
);
${POST_IMAGE_SCHEMA_SQL}
DROP VIEW IF EXISTS memory_sync_posts;
CREATE VIEW memory_sync_posts AS
  SELECT p.post_id, p.author, p.title, p.tag_ids_json, COALESCE(v.version, 0) AS content_version,
    ${rowJson('memory', 'm')} AS memory_json, p.image_group_json,
    ${imageAssets('p')} AS image_assets_json, ${imageDescription('p', false)} AS image_description
  FROM baiyun_post_metadata p JOIN memories m ON m.id = p.post_id
  LEFT JOIN baiyun_post_content_versions v ON v.post_id = p.post_id;
DROP VIEW IF EXISTS memory_sync_post_comments;
CREATE VIEW memory_sync_post_comments AS
  SELECT p.post_id, p.source, p.current_id, p.author, p.created_at, p.updated_at, p.deleted,
    CASE WHEN p.deleted = 0 AND c.id IS NOT NULL THEN ${rowJson('comment', 'c', true)} ELSE NULL END AS comment_json,
    CASE WHEN p.deleted = 0 THEN p.image_group_json ELSE NULL END AS image_group_json,
    CASE WHEN p.deleted = 0 THEN ${imageAssets('p')} ELSE '[]' END AS image_assets_json,
    CASE WHEN p.deleted = 0 THEN ${imageDescription('p', true)} ELSE NULL END AS image_description
  FROM baiyun_post_comment_metadata p LEFT JOIN memory_comments c ON c.id = p.current_id;
`;

export type PostBusinessStatement = { sql: string; params: (string | number | null)[] };
function upsert(kind: string, record: Record<string, unknown>): PostBusinessStatement {
  const spec = getMemoryRecordEntitySpec(kind)!;
  const fields = columns(kind);
  const updates = fields.filter(field => !spec.idColumns.includes(field));
  return { sql: `INSERT INTO ${spec.tableName} (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})
    ON CONFLICT(${spec.idColumns.join(',')}) DO UPDATE SET ${updates.map(field => `${field}=excluded.${field}`).join(',')}`,
  params: fields.map(field => (record[field] ?? null) as string | number | null) };
}

function imageStatements(record: Record<string, unknown>, comment: boolean): PostBusinessStatement[] {
  if (!('image_group_json' in record)) return []; // v5 text-only packets preserve existing local images.
  const postId = String(record.post_id), source = comment ? String(record.source) : null;
  const assets = JSON.parse(String(record.image_assets_json)) as Record<string, unknown>[];
  const statements: PostBusinessStatement[] = assets.map(asset => ({
    sql: `INSERT INTO baiyun_post_images (id,width,height,byte_size,object_id,chunk_count) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET width=excluded.width,height=excluded.height,byte_size=excluded.byte_size,
        object_id=excluded.object_id,chunk_count=excluded.chunk_count`,
    params: ['id', 'width', 'height', 'byte_size', 'object_id', 'chunk_count'].map(field => asset[field] as string | number | null),
  }));
  statements.push({ sql: comment
    ? 'UPDATE baiyun_post_comment_metadata SET image_group_json = ? WHERE post_id = ? AND source = ?'
    : 'UPDATE baiyun_post_metadata SET image_group_json = ? WHERE post_id = ?',
  params: comment ? [record.image_group_json as string | null, postId, source] : [record.image_group_json as string | null, postId] });
  if (record.image_group_json && record.image_description) {
    const group = JSON.parse(String(record.image_group_json));
    statements.push({ sql: `INSERT INTO baiyun_post_image_vision
      (owner_key,post_id,comment_source,group_key,description,opportunity_id,opportunity_at)
      VALUES (?,?,?,?,?,'',0) ON CONFLICT(owner_key) DO UPDATE SET group_key=excluded.group_key,description=excluded.description`,
    params: [JSON.stringify([postId, source]), postId, source,
      JSON.stringify([group.id, group.version, group.imageIds]), String(record.image_description)] });
  }
  // A missing peer description leaves already completed knowledge of this same group intact.
  // Changing/clearing a group uses native triggers to remove its former description.
  return statements;
}

export function buildBaiyunPostBusinessStatements(
  kind: string, entityId: string, operation: SyncOperation, record: Record<string, unknown>,
): PostBusinessStatement[] {
  if (kind === 'post-tag') return [operation === 'delete'
    ? { sql: 'DELETE FROM baiyun_post_tags WHERE id = ?', params: [entityId] }
    : upsert(kind, { merged_into_id: null, merged_at: null, updated_at: 0,
      version_id: `legacy:${record.id}`, ...record }),
  { sql: 'INSERT OR IGNORE INTO baiyun_post_tag_settings (singleton,seeded) VALUES (1,1)', params: [] }];
  if (kind === 'post') {
    if (operation === 'delete') return [
      { sql: 'DELETE FROM memory_comments WHERE memory_id = ?', params: [entityId] },
      { sql: 'DELETE FROM baiyun_post_comment_metadata WHERE post_id = ?', params: [entityId] },
      { sql: 'DELETE FROM baiyun_post_metadata WHERE post_id = ?', params: [entityId] },
      { sql: 'DELETE FROM baiyun_post_content_versions WHERE post_id = ?', params: [entityId] },
      { sql: 'DELETE FROM memories WHERE id = ?', params: [entityId] },
    ];
    return [upsert('memory', JSON.parse(String(record.memory_json))),
      { sql: `INSERT INTO baiyun_post_metadata (post_id,author,title,tag_ids_json) VALUES (?,?,?,?)
        ON CONFLICT(post_id) DO UPDATE SET author=excluded.author,title=excluded.title,tag_ids_json=excluded.tag_ids_json`,
      params: [String(record.post_id), String(record.author), record.title as string | null, String(record.tag_ids_json)] },
      ...imageStatements(record, false),
      { sql: `INSERT INTO baiyun_post_content_versions (post_id,version) VALUES (?,?)
        ON CONFLICT(post_id) DO UPDATE SET version=excluded.version`, params: [String(record.post_id), Number(record.content_version)] },
    ];
  }
  if (kind === 'post-comment') {
    const [postId, source] = operation === 'delete' ? JSON.parse(entityId) : [record.post_id, record.source];
    const deleted = operation === 'delete' || record.deleted === 1;
    const result: PostBusinessStatement[] = [];
    if (!deleted) result.push(upsert('comment', JSON.parse(String(record.comment_json))));
    if (operation === 'delete') result.push({ sql: 'DELETE FROM baiyun_post_comment_metadata WHERE post_id = ? AND source = ?', params: [postId, source] });
    else result.push({ sql: `INSERT INTO baiyun_post_comment_metadata
      (post_id,source,current_id,author,created_at,updated_at,deleted) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(post_id,source) DO UPDATE SET current_id=excluded.current_id,author=excluded.author,
        created_at=excluded.created_at,updated_at=excluded.updated_at,deleted=excluded.deleted,
        image_group_json=CASE WHEN excluded.deleted=1 THEN NULL ELSE baiyun_post_comment_metadata.image_group_json END`,
    params: [postId, source, record.current_id as string | null, String(record.author), Number(record.created_at), Number(record.updated_at), Number(record.deleted)] });
    if (operation !== 'delete') result.push(...imageStatements(record, true));
    // Move the logical pointer before removing old physical rows, as the local editor does.
    result.push({ sql: `DELETE FROM memory_comments WHERE memory_id = ?
      AND COALESCE(source,'baiyun-post-comment:' || id) = ? ${deleted ? '' : 'AND id <> ?'}`,
    params: deleted ? [postId, source] : [postId, source, String(record.current_id)] });
    return result;
  }
  throw new Error('post business kind 无效。');
}
