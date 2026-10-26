export const SYNC_TRANSPORT_HISTORY_RETENTION_MS =
  30 * 24 * 60 * 60 * 1_000;

export const SYNC_DIAGNOSTIC_RETENTION_MS =
  14 * 24 * 60 * 60 * 1_000;

export const DELETE_EXPIRED_ACKED_SYNC_OUTBOX_SQL = `
  DELETE FROM sync_outbox
  WHERE state = 'acked'
    AND updated_at <= ?
`;

export const DELETE_EXPIRED_APPLIED_SYNC_INBOX_SQL = `
  DELETE FROM sync_inbox
  WHERE state = 'applied'
    AND applied_at IS NOT NULL
    AND applied_at <= ?
    AND relay_cursor <= COALESCE((
      SELECT cursor_value FROM sync_cursors
      WHERE stream_id = 'relay-v1'
    ), 0)
`;

export function syncTransportHistoryCutoff(now: number) {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error('同步传输记录清理时间无效。');
  }
  return now - SYNC_TRANSPORT_HISTORY_RETENTION_MS;
}
