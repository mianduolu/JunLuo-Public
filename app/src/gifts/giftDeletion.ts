import type { SQLiteDatabase } from 'expo-sqlite';

export type GiftDeletionMode = 'keep-memory' | 'delete-related-memory';
type SourceRef = { sessionId: string };
type CandidateRow = { batch_id: string; item_key: string; candidate_json: string };
type Evidence = { kind?: string; sessionId?: string; memoryId?: string };
type Basis = { understandingBasis?: { evidence?: Evidence[] }; continuationReview?: { evidence?: Evidence[] };
  currentStateReview?: { evidence?: Evidence[]; targetCurrentStateId?: string | null };
  weeklyContextBasis?: { materials?: { memoryId: string }[] } };

/** IDs may contain colons; only the final positive integer is a revision. */
export function isSourceOfGift(sessionId: string, giftId: string) {
  const match = /^gift-source:(.+):([1-9]\d*)$/.exec(sessionId);
  return !!match && match[1] === giftId && Number.isSafeInteger(Number(match[2]));
}
function onlyGift(refs: readonly SourceRef[] | undefined, giftId: string) {
  return !!refs?.length && refs.every(ref => isSourceOfGift(ref.sessionId, giftId));
}

/** Caller owns the gift writer/epoch and supplied transaction. Never opens a nested writer. */
export async function deleteGiftRelationsWithDatabase(database: SQLiteDatabase, giftId: string, mode: GiftDeletionMode) {
  if (!['keep-memory', 'delete-related-memory'].includes(mode)) throw Error('gift-invalid-deletion-mode');
  for (const table of ['gift_attachment_activity', 'gift_processing_state', 'gift_understanding_receipts', 'gift_echoes', 'gift_echo_reads']) {
    await database.runAsync(`DELETE FROM ${table} WHERE gift_id = ?`, giftId);
  }
  const creative = await database.getFirstAsync<{ revision: number; state_json: string }>(
    'SELECT revision, state_json FROM gift_creation_run WHERE singleton = 1');
  if (creative) {
    const state = JSON.parse(creative.state_json) as { revision: number; run?: { checkpoint: {
      giftIds?: string[]; session?: { gifts?: { id: string }[]; sources?: { gift?: { id: string } }[] } } } | null };
    const checkpoint = state.run?.checkpoint;
    if (checkpoint?.giftIds?.includes(giftId) || checkpoint?.session?.gifts?.some(gift => gift.id === giftId)
      || checkpoint?.session?.sources?.some(source => source.gift?.id === giftId)) {
      await database.runAsync('UPDATE gift_creation_run SET revision = ?, state_json = ? WHERE singleton = 1 AND revision = ?',
        creative.revision + 1, JSON.stringify({ ...state, revision: creative.revision + 1, run: null }), creative.revision);
    }
  }
  // Pending proposals are unfinished work, rather than memories already accepted by you.
  // A supporting legacy card may have no refs to merge; its explicit basis still
  // makes the proposal mixed/unknown, rather than exclusively this gift.
  const eligibility = new Map<string, boolean>(), checking = new Set<string>();
  async function memoryOnlyGift(id: string): Promise<boolean> {
    if (eligibility.has(id)) return eligibility.get(id)!;
    if (checking.has(id)) return false;
    checking.add(id);
    try {
      const row = await database.getFirstAsync<{ understanding_basis_json: string | null; weekly_context_basis_json: string | null }>(
        'SELECT understanding_basis_json, weekly_context_basis_json FROM memories WHERE id = ?', id);
      const refs = await database.getAllAsync<SourceRef>('SELECT session_id AS sessionId FROM memory_source_refs WHERE memory_id = ?', id);
      const result = !!row && onlyGift(refs, giftId) && await basisOnlyGift({
        understandingBasis: row.understanding_basis_json ? JSON.parse(row.understanding_basis_json) : undefined,
        weeklyContextBasis: row.weekly_context_basis_json ? JSON.parse(row.weekly_context_basis_json) : undefined });
      eligibility.set(id, result); return result;
    } finally { checking.delete(id); }
  }
  async function basisOnlyGift(value: Basis) {
    const evidence = [...(value.understandingBasis?.evidence ?? []), ...(value.continuationReview?.evidence ?? []),
      ...(value.currentStateReview?.evidence ?? [])];
    for (const ref of evidence) {
      if (ref.kind === 'memory') { if (!ref.memoryId || !await memoryOnlyGift(ref.memoryId)) return false; }
      else if (!ref.sessionId || !isSourceOfGift(ref.sessionId, giftId)) return false;
    }
    for (const material of value.weeklyContextBasis?.materials ?? []) if (!await memoryOnlyGift(material.memoryId)) return false;
    const targetId = value.currentStateReview?.targetCurrentStateId;
    if (targetId) {
      const target = await database.getFirstAsync<{ source_refs_json: string | null }>('SELECT source_refs_json FROM memory_current_states WHERE id = ?', targetId);
      if (!target?.source_refs_json || !onlyGift(JSON.parse(target.source_refs_json) as SourceRef[], giftId)) return false;
    }
    return true;
  }
  const candidates = await database.getAllAsync<CandidateRow>(
    "SELECT batch_id, item_key, candidate_json FROM memory_ingestion_items WHERE candidate_json IS NOT NULL AND status IN ('pending', 'waiting')");
  const affected = new Set<string>();
  let deletedCandidates = 0;
  for (const row of candidates) {
    const candidate = JSON.parse(row.candidate_json) as Basis & { sourceRefs?: SourceRef[] };
    if (!onlyGift(candidate.sourceRefs, giftId) || !await basisOnlyGift(candidate)) continue;
    await database.runAsync('DELETE FROM memory_ingestion_items WHERE batch_id = ? AND item_key = ?', row.batch_id, row.item_key);
    affected.add(row.batch_id); deletedCandidates++;
  }
  const batches = await database.getAllAsync<{ id: string; work_metadata_json: string | null }>(
    'SELECT id, work_metadata_json FROM memory_ingestion_batches WHERE work_metadata_json IS NOT NULL');
  for (const batch of batches) {
    const metadata = JSON.parse(batch.work_metadata_json!) as { gift?: { bindings?: SourceRef[] } };
    if (!metadata.gift?.bindings?.some(ref => isSourceOfGift(ref.sessionId, giftId))) continue;
    // Removing cached proposals and settling the existing batch prevents paid late work
    // from registering again. Mixed candidates keep their text and fail source validation.
    const { gift: _gift, ...remaining } = metadata;
    await database.runAsync(`UPDATE memory_ingestion_batches SET status = 'stale', work_metadata_json = ?,
      completed_at = ?, updated_at = ? WHERE id = ?`, JSON.stringify(remaining), Date.now(), Date.now(), batch.id);
    affected.add(batch.id);
  }
  for (const id of affected) {
    await database.runAsync(`UPDATE memory_ingestion_batches SET
      item_count = (SELECT COUNT(*) FROM memory_ingestion_items WHERE batch_id = ?),
      resolved_count = (SELECT COUNT(*) FROM memory_ingestion_items WHERE batch_id = ? AND status NOT IN ('pending', 'waiting')),
      updated_at = ? WHERE id = ?`, id, id, Date.now(), id);
  }
  let deletedMemories = 0, deletedCurrentStates = 0;
  if (mode === 'delete-related-memory') {
    const prefix = `gift-source:${giftId}:`;
    const rows = await database.getAllAsync<{ memory_id: string }>(
      'SELECT DISTINCT memory_id FROM memory_source_refs WHERE substr(session_id, 1, ?) = ?', prefix.length, prefix);
    const ids: string[] = [];
    for (const row of rows) if (await memoryOnlyGift(row.memory_id)) ids.push(row.memory_id);
    for (const id of ids) {
      // Match the existing hard-delete dependencies without its UI archive prerequisite.
      await database.runAsync("UPDATE memory_current_states SET source_type = 'manual', source_memory_id = NULL, source_title = NULL WHERE source_memory_id = ?", id);
      await database.runAsync('UPDATE memory_ingestion_items SET memory_id = NULL WHERE memory_id = ?', id);
      for (const table of ['memory_timeline_members', 'memory_recall_feedback', 'memory_comments', 'memory_source_refs']) {
        await database.runAsync(`DELETE FROM ${table} WHERE memory_id = ?`, id);
      }
      await database.runAsync('DELETE FROM memory_comments WHERE source = ?', id);
      await database.runAsync('DELETE FROM memory_edges WHERE source_id = ? OR target_id = ?', id, id);
      await database.runAsync("DELETE FROM memory_embeddings WHERE target_kind = 'memory' AND memory_id = ?", id);
      await database.runAsync("DELETE FROM memory_processing_jobs WHERE target_kind = 'memory' AND memory_id = ?", id);
      await database.runAsync('DELETE FROM memory_lifecycle_events WHERE memory_id = ? OR related_memory_id = ?', id, id);
      await database.runAsync('DELETE FROM memory_merge_recovery_snapshots WHERE source_memory_id = ? OR target_memory_id = ?', id, id);
      await database.runAsync("DELETE FROM continuity_event_links WHERE relation = 'memory' AND target_kind = 'memory' AND target_id = ?", id);
      const removed = await database.runAsync('DELETE FROM memories WHERE id = ?', id);
      deletedMemories += removed.changes;
    }
    const states = await database.getAllAsync<{ id: string; source_refs_json: string; source_memory_id: string | null }>(
      'SELECT id, source_refs_json, source_memory_id FROM memory_current_states WHERE source_refs_json IS NOT NULL');
    for (const state of states) {
      if (!onlyGift(JSON.parse(state.source_refs_json) as SourceRef[], giftId)
        || state.source_memory_id && !await memoryOnlyGift(state.source_memory_id)) continue;
      await database.runAsync("DELETE FROM memory_embeddings WHERE target_kind = 'current_state' AND memory_id = ?", state.id);
      await database.runAsync("DELETE FROM memory_processing_jobs WHERE target_kind = 'current_state' AND memory_id = ?", state.id);
      const removed = await database.runAsync('DELETE FROM memory_current_states WHERE id = ?', state.id);
      deletedCurrentStates += removed.changes;
    }
  }
  return { deletedCandidates, deletedMemories, deletedCurrentStates };
}
