import type { SQLiteDatabase } from 'expo-sqlite';
import type { GiftSyncKind } from './syncGiftsLife';

export const GIFT_SYNC_SPECS = [
  { kind: 'gift', table: 'gift_records', id: (r: string) => `${r}.id`, gift: (r: string) => `${r}.id`,
    record: (r: string) => `json(${r}.record_json)` },
  { kind: 'echo', table: 'gift_echoes', id: (r: string) => `json_array(${r}.gift_id,${r}.id)`, gift: (r: string) => `${r}.gift_id`,
    record: (r: string) => `json_object('gift_id',${r}.gift_id,'id',${r}.id,'gift_revision',${r}.gift_revision,'sequence',${r}.sequence,
      'subject',${r}.subject,'content',${r}.content,'created_at',${r}.created_at,'origin',${r}.origin,'reply_to_id',${r}.reply_to_id,
      'attachment_id',${r}.attachment_id,'original_id',${r}.original_id,'read_at',${r}.read_at)` },
  { kind: 'activity', table: 'gift_attachment_activity', id: (r: string) => `json_array(${r}.gift_id,${r}.attachment_id,${r}.viewer)`, gift: (r: string) => `${r}.gift_id`,
    record: (r: string) => `json_object('gift_id',${r}.gift_id,'attachment_id',${r}.attachment_id,'viewer',${r}.viewer,'revision',${r}.revision,'record_json',${r}.record_json)` },
  { kind: 'understanding', table: 'gift_understanding_receipts', id: (r: string) => `json_array(${r}.gift_id,${r}.gift_revision,${r}.attachment_id)`, gift: (r: string) => `${r}.gift_id`,
    record: (r: string) => `json_object('gift_id',${r}.gift_id,'gift_revision',${r}.gift_revision,'attachment_id',${r}.attachment_id,
      'original_id',${r}.original_id,'subject',${r}.subject,'content',${r}.content,'understood_at',${r}.understood_at)` },
] as const;
const uuid = `(lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2,3)||'-'||substr('89ab',(random()&3)+1,1)||substr(lower(hex(randomblob(2))),2,3)||'-'||lower(hex(randomblob(6))))`;
const now = `CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)`;

export function giftSyncCaptureStatement(spec: typeof GIFT_SYNC_SPECS[number], row: string, deleting: boolean) {
  const payload = deleting
    ? `json_object('schemaVersion',1,'kind','${spec.kind}','giftId',${spec.gift(row)},'deletedAt',${now},
        'deleteRelatedMemory',json(CASE WHEN (SELECT delete_related_memory FROM gift_sync_runtime WHERE singleton=1)=1 THEN 'true' ELSE 'false' END))`
    : `json_object('schemaVersion',1,'kind','${spec.kind}','record',${spec.record(row)})`;
  return `
    INSERT INTO gift_sync_changes(kind,entity_id,payload_json,mutation_id,revision_id,parent_ids_json)
    VALUES('${spec.kind}',${spec.id(row)},${payload},${uuid},${uuid},COALESCE(
      (SELECT parent_ids_json FROM gift_sync_changes WHERE kind='${spec.kind}' AND entity_id=${spec.id(row)} AND mutation_json IS NULL ORDER BY seq DESC LIMIT 1),
      (SELECT json_array(revision_id) FROM gift_sync_heads WHERE kind='${spec.kind}' AND entity_id=${spec.id(row)}),'[]'));
    DELETE FROM gift_sync_changes WHERE kind='${spec.kind}' AND entity_id=${spec.id(row)} AND mutation_json IS NULL AND seq<>last_insert_rowid();
    INSERT INTO gift_sync_heads(kind,entity_id,revision_id) SELECT kind,entity_id,revision_id FROM gift_sync_changes WHERE seq=last_insert_rowid()
      ON CONFLICT(kind,entity_id) DO UPDATE SET revision_id=excluded.revision_id;
  `;
}
export const GIFT_SYNC_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS gift_sync_runtime(singleton INTEGER PRIMARY KEY CHECK(singleton=1),suppressed INTEGER NOT NULL DEFAULT 0,
    delete_related_memory INTEGER NOT NULL DEFAULT 0,world_id TEXT);
  INSERT OR IGNORE INTO gift_sync_runtime(singleton) VALUES(1);
  CREATE TABLE IF NOT EXISTS gift_sync_heads(kind TEXT NOT NULL,entity_id TEXT NOT NULL,revision_id TEXT NOT NULL,PRIMARY KEY(kind,entity_id)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS gift_sync_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,entity_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,mutation_id TEXT NOT NULL,revision_id TEXT NOT NULL,parent_ids_json TEXT NOT NULL,mutation_json TEXT);
  ${GIFT_SYNC_SPECS.flatMap(spec => ['INSERT', 'UPDATE', 'DELETE'].map(action => {
    const row = action === 'DELETE' ? 'OLD' : 'NEW';
    return `CREATE TRIGGER IF NOT EXISTS gift_sync_${spec.kind}_${action.toLowerCase()} AFTER ${action} ON ${spec.table}
      WHEN (SELECT suppressed FROM gift_sync_runtime WHERE singleton=1)=0
      BEGIN ${giftSyncCaptureStatement(spec, row, action === 'DELETE')} END;`;
  })).join('\n')}
`;
export async function setGiftSyncDeleteMode(database: Pick<SQLiteDatabase, 'runAsync'>, mode: 'keep-memory' | 'delete-related-memory') {
  await database.runAsync('UPDATE gift_sync_runtime SET delete_related_memory=? WHERE singleton=1', mode === 'delete-related-memory' ? 1 : 0);
}
export type GiftSyncChange = { seq: number; kind: GiftSyncKind; entity_id: string; payload_json: string; mutation_id: string;
  revision_id: string; parent_ids_json: string; mutation_json: string | null };
