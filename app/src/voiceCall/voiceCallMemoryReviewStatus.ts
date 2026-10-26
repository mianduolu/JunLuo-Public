import { getMemoryDatabase } from '../memory/memoryStore';
import { completedVoiceCallRanges, loadVoiceCallMemoryBatches, isVoiceCallMemoryOrganizationRunning } from './voiceCallMemoryOrganizationRuntime';
import { prepareVoiceCallMemoryBatch } from './voiceCallMemoryOrganization';
import type { VoiceCallRecord } from './voiceCallRecord';

export type VoiceCallMemoryReviewStatus = {
  pending: number;
  saved: number;
  discarded: number;
  filtered: number;
};

export async function getVoiceCallMemoryReviewStatus(callId: string): Promise<VoiceCallMemoryReviewStatus> {
  const counts: VoiceCallMemoryReviewStatus = { pending: 0, saved: 0, discarded: 0, filtered: 0 };
  const database = await getMemoryDatabase('store');
  const rows = await database.getAllAsync<{ status: string; count: number }>(
    `SELECT i.status, COUNT(*) AS count
       FROM memory_ingestion_items i
       JOIN memory_ingestion_batches b ON b.id = i.batch_id
      WHERE b.stream = 'voice_call' AND b.source_last_message_id = ?
      GROUP BY i.status`,
    `voice-call-record-${callId}`,
  );
  for (const row of rows) {
    if (row.status === 'pending' || row.status === 'saved' || row.status === 'discarded') {
      counts[row.status] = Number(row.count) || 0;
    } else counts.filtered += Number(row.count) || 0;
  }
  return counts;
}

export async function getVoiceCallMemoryOrganizationStatus(record: VoiceCallRecord) {
  const batches = await loadVoiceCallMemoryBatches(record.callId);
  const counts = await getVoiceCallMemoryReviewStatus(record.callId);
  const processed = completedVoiceCallRanges(batches);
  const next = prepareVoiceCallMemoryBatch(record, processed);
  const waiting = batches.some(batch => batch.status === 'waiting'
    && !record.memoryOrganization?.segments.some(segment => segment.batchId === batch.id && segment.sourceStale));
  const failed = record.memoryOrganization?.status === 'failed' || next.blocked
    || record.memoryOrganization?.status === 'running' && !isVoiceCallMemoryOrganizationRunning(record.callId);
  const status = waiting ? 'waiting' : failed ? 'failed' : record.memoryOrganization?.status === 'running' ? 'running'
    : processed.length && !next.bindings.length && !next.remaining ? 'complete'
      : processed.length ? 'remaining' : 'unstarted';
  return { status, pending: counts.pending,
    text: status === 'running' ? '整理中' : status === 'complete'
      ? `已整理完${counts.pending ? ` · ${counts.pending} 张草稿待确认` : ''}`
      : status === 'failed' ? '整理未完成' : status === 'waiting' ? '还有内容未整理 · 等待处理眼前稿'
        : status === 'remaining' ? '还有内容未整理' : '未整理',
    action: status === 'failed' ? '重试' : status === 'remaining' || status === 'waiting' ? '继续整理' : '整理为记忆' };
}
