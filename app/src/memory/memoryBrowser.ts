import type { SQLiteDatabase } from 'expo-sqlite';
import { beginMemoryCandidateEdit, memoryCandidateEditableFields, memoryCandidateEditableHash, type MemoryCandidateReview } from './memoryCandidateReview';
import { getMemoryCandidateReviewStatus } from './memoryCandidatePersistence';
import { getMemoryDatabase, loadMemory, loadMemorySourceRefs, memoryFromRow, createMemory, type MemorySourceRefInput } from './memoryStore';
import { currentStateVersion, loadMemoryCurrentState, writeMemoryCurrentStateWithDatabase } from './memoryCurrentStateStore';
import { resolveMemoryIngestionItems, runMemoryCandidateSave, updatePendingMemoryCandidates, acknowledgeMemoryCandidateTarget } from './memoryIngestionService';
import { notifyMemoryProcessingUpdated, subscribeMemoryProcessingUpdates, subscribeMemoryProcessingWorkAvailable } from './memoryProcessingSignals';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { runMemoryDuplicateCleanupBusinessWrite } from './memoryDuplicateCleanupState';
import { stableMemoryHash } from './memoryAtomicity';
import { weeklyTargetHash } from './memoryWeeklyBasis';
import { loadMemorySourceEvidence } from './memorySourceReader';
import { getMemorySourceStatusLabel } from './memorySourceStatus';
import { isCompleteObservationExcerpt } from './memorySourceRefs';
import type { MemoryBrowserAction, MemoryBrowserActionResult, MemoryBrowserDetail, MemoryBrowserExternalPreview, MemoryBrowserPage, MemoryBrowserPreview, MemoryBrowserRequest } from './memoryBrowserTypes';

export * from './memoryBrowserTypes';
type Reader = Pick<SQLiteDatabase, 'getFirstAsync' | 'getAllAsync'>;
type PreviewRow = { id: string; kind: MemoryBrowserPreview['kind']; title: string; preview: string; at: number; known_at?: number; subject?: 'I' | 'you'; status: string; source?: string; waiting?: number; candidate_type?: 'understanding' | 'current_state' };
type DraftRow = { batch_id: string; item_key: string; candidate_json: string; status: string; stream: string };

const pendingRows = `SELECT i.*, b.stream,
  CASE WHEN b.stream = 'current_state' THEN 'legacy_current_state:' ELSE 'candidate:' END ||
    COALESCE(json_extract(CASE WHEN json_valid(i.candidate_json) THEN i.candidate_json ELSE '{}' END, '$.reviewId'), i.batch_id || ':' || i.item_key) AS id
  FROM memory_ingestion_items i JOIN memory_ingestion_batches b ON b.id = i.batch_id
  WHERE i.status IN ('pending', 'waiting') AND i.candidate_json IS NOT NULL
    AND b.status IN ('pending', 'ready', 'failed', 'waiting')`;
const safeJson = "CASE WHEN json_valid(candidate_json) THEN candidate_json ELSE '{}' END";
const draftProjection = `WITH pending AS (${pendingRows}), ranked AS (
  SELECT *, MIN(created_at) OVER (PARTITION BY id) AS first_at,
    ROW_NUMBER() OVER (PARTITION BY id ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, updated_at DESC, batch_id, item_key) AS rn FROM pending
), local AS (SELECT id,
  CASE WHEN stream = 'current_state' THEN 'legacy_current_state' ELSE 'candidate' END AS kind,
  COALESCE(json_extract(${safeJson}, '$.title'), '草稿读取失败') AS title,
  substr(COALESCE(json_extract(${safeJson}, '$.content'), ''), 1, 160) AS preview,
  first_at AS at, NULL AS known_at, json_extract(${safeJson}, '$.understandingSubject') AS subject,
  CASE WHEN json_valid(candidate_json) THEN status ELSE 'invalid' END AS status, stream AS source,
  CASE status WHEN 'waiting' THEN 1 ELSE 0 END AS waiting,
  CASE WHEN stream = 'current_state' OR json_type(${safeJson}, '$.currentStateReview') IS NOT NULL THEN 'current_state'
    WHEN json_extract(${safeJson}, '$.understandingSubject') IN ('I', 'you') THEN 'understanding' END AS candidate_type,
  COALESCE(json_extract(${safeJson}, '$.title'), '') || char(10) || COALESCE(json_extract(${safeJson}, '$.content'), '') || char(10) ||
    COALESCE(json_extract(${safeJson}, '$.tags'), '') || char(10) || COALESCE(json_extract(${safeJson}, '$.recallCues'), '') AS search_text,
  NULL AS search_matches
  FROM ranked WHERE rn = 1)`;

/** SQL filters and pages metadata before any complete text or evidence is read. */
export async function readMemoryBrowserPage(request: MemoryBrowserRequest, additionalPreviews: readonly MemoryBrowserExternalPreview[] = []): Promise<MemoryBrowserPage> {
  const epoch = captureBackupRestoreDataEpoch();
  const page = await readMemoryBrowserPageWithDatabase(await getMemoryDatabase('ingestion'), request, additionalPreviews);
  if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('MEMORY_DATA_CHANGED');
  return page;
}

export async function readMemoryBrowserPageWithDatabase(database: Reader, request: MemoryBrowserRequest,
  additionalPreviews: readonly MemoryBrowserExternalPreview[] = []): Promise<MemoryBrowserPage> {
  const pending = request.section === 'pending';
  const external = pending ? [...new Map(additionalPreviews.map(item => [item.id, item])).values()] : [];
  const projection = pending ? `${draftProjection}, external AS (
    SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.kind') AS kind, json_extract(value, '$.title') AS title,
      json_extract(value, '$.preview') AS preview, json_extract(value, '$.createdAt') AS at, NULL AS known_at,
      json_extract(value, '$.subject') AS subject, json_extract(value, '$.status') AS status, json_extract(value, '$.source') AS source,
      COALESCE(json_extract(value, '$.waiting'), 0) AS waiting, json_extract(value, '$.candidateType') AS candidate_type,
      json_extract(value, '$.searchText') AS search_text, json_extract(value, '$.searchMatches') AS search_matches FROM json_each(?)
  ), items AS (SELECT * FROM local WHERE id NOT IN (SELECT id FROM external) UNION ALL SELECT * FROM external)`
    : request.section === 'current_states' ? `WITH items AS (SELECT 'current_state:' || id AS id, 'current_state' AS kind, title,
      substr(content, 1, 160) AS preview, updated_at AS at, known_at, NULL AS subject, status, source_type AS source, 0 AS waiting,
      'current_state' AS candidate_type, title || char(10) || content AS search_text FROM memory_current_states)`
      : `WITH items AS (SELECT 'understanding:' || id AS id, 'understanding' AS kind, title, substr(content, 1, 160) AS preview,
        created_at AS at, NULL AS known_at, understanding_subject AS subject, type AS status, source, 0 AS waiting,
        'understanding' AS candidate_type, title || char(10) || content || char(10) || COALESCE(tags_json, '') || char(10) || COALESCE(recall_cues_json, '') AS search_text
        FROM memories WHERE understanding_subject IN ('I', 'you'))`;
  const values: Array<string | number> = pending ? [JSON.stringify(external)] : [];
  const filters: string[] = [];
  if (request.section === 'current_states') filters.push("status = 'active'");
  if (request.section === 'understandings') {
    filters.push(request.history ? "status = 'archived'" : "status != 'archived'");
    if (request.subject) { filters.push('subject = ?'); values.push(request.subject); }
  }
  if (pending && request.candidateType && request.candidateType !== 'all') { filters.push('candidate_type = ?'); values.push(request.candidateType); }
  if (pending && request.subject) { filters.push('subject = ?'); values.push(request.subject); }
  const search = request.search?.trim();
  if (search) {
    filters.push(pending ? "(search_matches = 1 OR (search_matches IS NULL AND search_text LIKE ? ESCAPE '\\'))" : "search_text LIKE ? ESCAPE '\\'");
    values.push(`%${search.replace(/[\\%_]/g, '\\$&')}%`);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const count = await database.getFirstAsync<{ count: number }>(`${projection} SELECT COUNT(*) AS count FROM items ${where}`, ...values);
  const paging = [...filters];
  const pageValues = [...values];
  const direction = pending ? 'ASC' : 'DESC';
  if (request.cursor) {
    paging.push(`(at ${pending ? '>' : '<'} ? OR (at = ? AND id ${pending ? '>' : '<'} ?))`);
    pageValues.push(request.cursor.at, request.cursor.at, request.cursor.id);
  }
  const limit = Math.min(12, Math.max(1, Math.floor(request.limit ?? 12)));
  const rows = await database.getAllAsync<PreviewRow>(`${projection} SELECT id, kind, title, preview, at, known_at, subject, status, source, waiting, candidate_type
    FROM items ${paging.length ? `WHERE ${paging.join(' AND ')}` : ''} ORDER BY at ${direction}, id ${direction} LIMIT ?`, ...pageValues, limit + 1);
  const pageRows = rows.slice(0, limit);
  const items = await Promise.all(pageRows.map(async row => {
    let status = row.status;
    if (row.kind === 'understanding' && row.status !== 'archived') {
      const raw = await database.getFirstAsync<Parameters<typeof memoryFromRow>[0]>('SELECT * FROM memories WHERE id = ?', row.id.slice('understanding:'.length));
      if (!raw) status = 'missing';
      else {
        try { status = await (await import('./memoryUnderstanding')).getUnderstandingStatus(database, memoryFromRow(raw)); }
        catch { status = 'read_failed'; }
      }
    }
    return { id: row.id, kind: row.kind, title: row.title, preview: row.preview, createdAt: row.at,
      ...(row.known_at != null ? { knownAt: row.known_at } : {}), ...(row.subject ? { subject: row.subject } : {}),
      status, source: row.source, waiting: !!row.waiting, ...(row.candidate_type ? { candidateType: row.candidate_type } : {}) };
  }));
  const last = pageRows.at(-1);
  return { items, total: count?.count ?? 0, hasMore: rows.length > limit,
    ...(rows.length > limit && last ? { nextCursor: { at: last.at, id: last.id } } : {}) };
}

async function draftRows(database: Reader, id: string) {
  return database.getAllAsync<DraftRow>(`WITH pending AS (${pendingRows}) SELECT batch_id, item_key, candidate_json, status, stream FROM pending
    WHERE id = ? ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, updated_at DESC, batch_id, item_key`, id);
}

async function sourceDetails(refs: MemorySourceRefInput[]): Promise<MemoryBrowserDetail['sources']> {
  if (!refs.length) return [{ label: '原话未找到', content: '' }];
  return Promise.all(refs.map(async ref => {
    // A store read failure rejects the read; it is never presented as missing.
    let evidence: Awaited<ReturnType<typeof loadMemorySourceEvidence>>;
    try { evidence = await loadMemorySourceEvidence(ref.sessionId, ref.messageId); }
    catch { return { label: '来源读取失败', content: `${ref.sessionId} · ${ref.messageId}\n当前无法读取原件；不能据此判断原话是否缺失。` }; }
    const observation = ref.sessionId.startsWith('observation-source:');
    const matchesRole = evidence?.kind === 'observation' || evidence?.kind === 'message' && evidence.message.role === ref.role;
    const excerpt = observation ? isCompleteObservationExcerpt(ref.excerpt) ? ref.excerpt : '' : ref.excerpt ?? '';
    const status = matchesRole ? 'exact' : excerpt.trim() ? 'retained_excerpt' : 'missing';
    const giftSource = /^gift-source:(.+):([1-9]\d*)$/.exec(ref.sessionId);
    let deletedGift = false;
    if (!evidence && giftSource && Number.isSafeInteger(Number(giftSource[2]))) {
      try { deletedGift = !await (await import('../gifts/giftStore')).loadGift(giftSource[1]); }
      catch { return { label: '来源读取失败', content: `${ref.sessionId} · ${ref.messageId}\n当前无法读取原件；不能据此判断原话是否缺失。` }; }
    }
    const content = matchesRole && evidence?.kind === 'message'
      ? `${evidence.message.role === 'I' ? '白云小姐' : '小仓鼠'} · ${new Date(evidence.message.createdAt).toLocaleString('zh-CN')}\n${evidence.message.content}`
      : evidence?.kind === 'observation' ? JSON.stringify(evidence.record.result, null, 2) : excerpt;
    return { label: `${deletedGift ? '礼物来源已删除' : getMemorySourceStatusLabel(status, observation)} · ${ref.relation === 'derived' ? '派生来源' : '直接来源'}`,
      content: `${ref.sessionId} · ${ref.messageId}\n${ref.role === 'I' ? '白云小姐' : '小仓鼠'} · ${new Date(ref.messageCreatedAt).toLocaleString('zh-CN')}\n${content}` };
  }));
}

export async function readMemoryBrowserItem(id: string): Promise<MemoryBrowserDetail> {
  const epoch = captureBackupRestoreDataEpoch();
  const database = await getMemoryDatabase('ingestion');
  let result: MemoryBrowserDetail;
  if (id.startsWith('current_state:')) {
    const state = await loadMemoryCurrentState(id.slice('current_state:'.length), database);
    if (!state) throw new Error('MEMORY_CURRENT_STATE_MISSING');
    result = { id, kind: 'current_state', status: state.status, currentState: state, editableHash: currentStateVersion(state), sources: await sourceDetails(state.sourceRefs) };
  } else if (id.startsWith('understanding:')) {
    const memory = await loadMemory(id.slice('understanding:'.length));
    if (!memory?.understandingSubject) throw new Error('MEMORY_UNDERSTANDING_MISSING');
    let status = memory.type === 'archived' ? 'archived' : 'read_failed';
    if (memory.type !== 'archived') {
      try { status = await (await import('./memoryUnderstanding')).getUnderstandingStatus(database, memory); } catch { /* Read failure stays distinct. */ }
    }
    result = { id, kind: 'understanding', memory, status, sources: await sourceDetails(await loadMemorySourceRefs(memory.id, database)) };
    if (memory.sourceTraceMode === 'legacy_range') {
      const groups = await (await import('./memorySourceTrace')).loadMemorySourceSelectionCandidates(memory);
      result.sources = groups.flatMap(group => group.messages.map(message => ({ label: '附近聊天，未确认出处',
        content: `${group.sessionId} · ${message.id}\n${message.role === 'I' ? '白云小姐' : '小仓鼠'} · ${new Date(message.createdAt).toLocaleString('zh-CN')}\n${message.content}` })));
      if (!result.sources.length) result.sources = [{ label: '原话未找到', content: '' }];
    }
    try {
      const evidence = await (await import('./memoryUnderstandingReview')).loadUnderstandingEvidence(memory);
      result.sources.push(...evidence.map(item => ({ label: `${item.label} · ${item.current ? '依据一致' : '依据待核对'}`, content: item.text })));
    } catch { result.status = 'read_failed'; result.sources.push({ label: '依据读取失败', content: '原件暂不可用；不能据此判断依据是否缺失。' }); }
  } else {
    const rows = await draftRows(database, id);
    if (!rows.length) throw new Error('MEMORY_CANDIDATE_CHANGED');
    const stored = JSON.parse(rows[0].candidate_json) as MemoryCandidateReview;
    if (!stored.reviewId || typeof stored.title !== 'string' || typeof stored.content !== 'string') throw new Error('MEMORY_CANDIDATE_INVALID');
    const waiting = rows.every(row => row.status === 'waiting');
    if (rows[0].stream === 'current_state') {
      result = { id, kind: 'legacy_current_state', status: 'basis_changed', waiting,
        legacyCurrentState: { ...(stored as unknown as NonNullable<MemoryBrowserDetail['legacyCurrentState']>), ingestionRef: { batchId: rows[0].batch_id, itemKey: rows[0].item_key }, requiresRecheck: true },
        editableHash: stableMemoryHash(rows[0].candidate_json), sources: await sourceDetails(stored.sourceRefs ?? []) };
    } else {
      if (!Array.isArray(stored.tags)) throw new Error('MEMORY_CANDIDATE_INVALID');
      const refs = new Map(rows.map(row => [`${row.batch_id}\0${row.item_key}`, { batchId: row.batch_id, itemKey: row.item_key }]));
      const candidate = beginMemoryCandidateEdit({ ...stored, ingestionRefs: [...refs.values()] });
      let checked: Awaited<ReturnType<typeof getMemoryCandidateReviewStatus>> | undefined;
      try { checked = await getMemoryCandidateReviewStatus(database, candidate); }
      catch { /* Display remains available; a failed evidence read never authorizes saving. */ }
      if (checked) candidate.reviewStatus = checked.status;
      result = { id, kind: 'candidate', status: checked?.status ?? 'read_failed', waiting, candidate,
        editableHash: memoryCandidateEditableHash(candidate), sources: await sourceDetails(candidate.sourceRefs ?? []) };
      if (result.sources.some(item => item.label === '来源读取失败')) result.status = 'read_failed';
      const target = checked?.target;
      if (target) result.comparison = { title: target.title, content: target.content, hash: weeklyTargetHash(target), draft: { ...target } };
      if (checked?.targetCurrentState) result.comparison = { title: checked.targetCurrentState.title, content: checked.targetCurrentState.content, hash: currentStateVersion(checked.targetCurrentState) };
      if (candidate.readingBinding) {
        try { result.readingSource = (await (await import('../reading/readingMemoryReview')).loadReadingMemoryCandidateComparison(candidate, database)).preview; }
        catch { result.status = 'read_failed'; result.sources.push({ label: '来源读取失败', content: '阅读原件暂不可用，原稿保留。' }); }
      }
      if (candidate.readingSourcePreview) result.readingSource = { content: candidate.readingSourcePreview,
        version: [...(candidate.readingBindings ?? []), ...(candidate.shiyingBindings ?? [])].map(binding => binding.version).join(' / ') };
      if (candidate.origin === 'history_import') {
        try {
          const history = candidate as import('./memoryHistoryImportStore').HistoryImportCandidate;
          const original = await (await import('./memoryHistoryImportStore')).loadHistoryImportSource({ importId: history.historyImportId });
          result.sources = original ? [{ label: `历史导入原文 · ${original.fileName}`, content: original.content }] : result.sources;
        } catch { result.status = 'read_failed'; result.sources.push({ label: '来源读取失败', content: '历史导入原件暂不可用，原稿保留。' }); }
      }
    }
  }
  if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('MEMORY_DATA_CHANGED');
  return result;
}

export function subscribeMemoryBrowserChanges(listener: () => void) {
  const subscriptions = [subscribeMemoryProcessingUpdates(listener), subscribeMemoryProcessingWorkAvailable(reason => {
    if (reason === 'memory_changed' || reason === 'app_resumed') listener();
  })];
  return () => subscriptions.forEach(unsubscribe => unsubscribe());
}

function checkBrowserEpoch(epoch: number | null) {
  if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('MEMORY_DATA_CHANGED');
}

async function saveCandidate(candidate: MemoryCandidateReview, epoch: number | null) {
  if (candidate.readingBinding) {
    const module = await import('../reading/readingMemoryReview'); checkBrowserEpoch(epoch);
    return (await module.saveReadingMemoryCandidate(candidate)).id;
  }
  if (candidate.origin === 'post') {
    const module = await import('../posts/baiyunPostMemoryRuntime'); checkBrowserEpoch(epoch);
    const id = await module.savePostReviewCandidate(candidate, epoch);
    if (typeof id !== 'string') throw new Error('MEMORY_SAVE_RECEIPT_INVALID');
    return id;
  }
  if (candidate.origin === 'history_import') {
    const module = await import('./memoryHistoryImportStore'); checkBrowserEpoch(epoch);
    const id = await module.resolveStoredHistoryCandidate(candidate as import('./memoryHistoryImportStore').HistoryImportCandidate, 'saved');
    if (!id) throw new Error('MEMORY_CANDIDATE_CHANGED');
    return id;
  }
  if (candidate.currentStateReview) { const module = await import('./memoryCurrentStateReview'); checkBrowserEpoch(epoch); return module.saveCurrentStateReview(candidate, { dataEpoch: epoch }); }
  if (candidate.understandingSubject) { const module = await import('./memoryUnderstandingReview'); checkBrowserEpoch(epoch); return module.saveUnderstandingCandidate(candidate, { dataEpoch: epoch }); }
  if (candidate.continuationReview) { const module = await import('./memoryEpisodeReview'); checkBrowserEpoch(epoch); return module.saveConversationMemoryCandidate(candidate, { dataEpoch: epoch }); }
  if (candidate.source === 'weekly-context') { const module = await import('./memoryWeeklyCandidateActions'); checkBrowserEpoch(epoch); return module.saveWeeklyCandidate(candidate); }
  return runMemoryCandidateSave(candidate, (stored, dataEpoch) => createMemory(stored, { confirmationLevel: 'reviewed', sourceRefs: stored.sourceRefs,
    ingestionResolutions: stored.ingestionRefs, requirePendingIngestion: true, dataEpoch,
    ingestionExpectedCandidate: { reviewId: stored.reviewId, editableHash: memoryCandidateEditableHash(stored) } }), { dataEpoch: epoch });
}

/** Page input edits only exposed fields; identity/evidence/targets always come from the host record. */
export async function actOnMemoryBrowserCandidate(input: MemoryBrowserAction): Promise<MemoryBrowserActionResult> {
  const actionEpoch = captureBackupRestoreDataEpoch();
  checkBrowserEpoch(actionEpoch);
  let detail: MemoryBrowserDetail;
  try { detail = await readMemoryBrowserItem(input.id); }
  catch (error) {
    if (!(error instanceof Error) || error.message !== 'MEMORY_CANDIDATE_CHANGED' || input.action !== 'save'
      || !input.expectedEditableHash || !input.id.startsWith('candidate:')) throw error;
    const database = await getMemoryDatabase('ingestion');
    const receipt = await database.getFirstAsync<{ memory_id: string | null; state_id: string | null }>(
      `SELECT memory_id, json_extract(candidate_json, '$.savedCurrentStateId') AS state_id FROM memory_ingestion_items
       WHERE status = 'saved' AND json_extract(candidate_json, '$.savedReviewId') = ?
         AND json_extract(candidate_json, '$.savedEditableHash') = ? LIMIT 1`, input.id.slice('candidate:'.length), input.expectedEditableHash);
    const savedId = receipt?.memory_id ?? receipt?.state_id;
    if (!savedId || !await database.getFirstAsync(`SELECT id FROM ${receipt?.state_id ? 'memory_current_states' : 'memories'} WHERE id = ?`, savedId)) throw error;
    checkBrowserEpoch(actionEpoch);
    return { state: 'saved', savedId };
  }
  checkBrowserEpoch(actionEpoch);
  if (input.expectedEditableHash && detail.editableHash !== input.expectedEditableHash) throw new Error('MEMORY_CANDIDATE_CHANGED');
  if (input.action === 'close' && detail.currentState) {
    if (!input.expectedEditableHash) throw new Error('MEMORY_CANDIDATE_CHANGED');
    const state = detail.currentState;
    const epoch = actionEpoch;
    const outcome = await runBackupRestoreDataEpochCommit(epoch, () => runMemoryDuplicateCleanupBusinessWrite(async () => {
      const database = await getMemoryDatabase('current_state');
      await database.withExclusiveTransactionAsync(async transaction => {
        if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('MEMORY_DATA_CHANGED');
        await writeMemoryCurrentStateWithDatabase(transaction, { action: 'close', id: state.id, expectedVersion: input.expectedEditableHash,
          title: state.title, content: state.content, resolveReason: 'user_closed' });
      });
    }));
    if (!outcome.committed) throw new Error('MEMORY_DATA_CHANGED');
    notifyMemoryProcessingUpdated();
    return { state: 'applied', detail: await readMemoryBrowserItem(input.id) };
  }
  if (detail.legacyCurrentState) {
    if (!input.expectedEditableHash) throw new Error('MEMORY_CANDIDATE_CHANGED');
    if (input.action === 'edit') {
      const epoch = actionEpoch;
      const result = await runBackupRestoreDataEpochCommit(epoch, () => runMemoryDuplicateCleanupBusinessWrite(async () => {
        const database = await getMemoryDatabase('ingestion');
        await database.withExclusiveTransactionAsync(async transaction => {
          const rows = await draftRows(transaction, input.id);
          if (!rows.length || stableMemoryHash(rows[0].candidate_json) !== input.expectedEditableHash || !canCommitBackupRestoreDataEpoch(epoch)) throw new Error('MEMORY_CANDIDATE_CHANGED');
          for (const row of rows) {
            const old = JSON.parse(row.candidate_json);
            const next = { ...old, ...(typeof input.patch?.title === 'string' ? { title: input.patch.title } : {}),
              ...(typeof input.patch?.content === 'string' ? { content: input.patch.content } : {}) };
            await transaction.runAsync("UPDATE memory_ingestion_items SET candidate_json = ?, updated_at = ? WHERE batch_id = ? AND item_key = ? AND status IN ('pending', 'waiting')",
              JSON.stringify(next), Date.now(), row.batch_id, row.item_key);
          }
        });
      }));
      if (!result.committed) throw new Error('MEMORY_DATA_CHANGED');
      notifyMemoryProcessingUpdated();
      return { state: 'applied', detail: await readMemoryBrowserItem(input.id) };
    }
    if (input.action === 'discard') {
      const rows = await draftRows(await getMemoryDatabase('ingestion'), input.id);
      await resolveMemoryIngestionItems(rows.map(row => ({ batchId: row.batch_id, itemKey: row.item_key })), 'discarded', {
        expectedCandidateJsonHash: input.expectedEditableHash,
        dataEpoch: actionEpoch,
      });
    }
    else if (input.action === 'recheck' && !detail.waiting) {
      const module = await import('./memoryCurrentStateReview'); checkBrowserEpoch(actionEpoch);
      const candidate = await module.recheckCurrentStateCandidate(detail.legacyCurrentState);
      notifyMemoryProcessingUpdated();
      return { state: 'applied', detail: await readMemoryBrowserItem(`candidate:${candidate.reviewId}`) };
    } else throw new Error('旧近况稿需要重新核对后保存。');
    notifyMemoryProcessingUpdated();
    return { state: 'discarded' };
  }
  if (!detail.candidate || !input.expectedEditableHash) throw new Error('MEMORY_CANDIDATE_CHANGED');
  if ((input.action === 'save' || input.action === 'recheck' || input.action === 'compare') && detail.status === 'read_failed') throw new Error('来源读取失败，原稿保留，请稍后重新读取。');
  if (detail.waiting && input.action !== 'discard' && input.action !== 'edit') throw new Error('请先处理前一份草稿，这份仍会保留。');
  let candidate = beginMemoryCandidateEdit({ ...detail.candidate,
    ...memoryCandidateEditableFields({ ...detail.candidate, ...(input.patch ?? {}),
      understandingSubject: detail.candidate.understandingSubject, currentStateReview: detail.candidate.currentStateReview,
      readingBinding: detail.candidate.readingBinding, continuationReview: detail.candidate.continuationReview,
      episodeSummaryEnabled: detail.candidate.episodeSummaryEnabled, origin: detail.candidate.origin, source: detail.candidate.source }) }, detail.editableHash);
  await updatePendingMemoryCandidates([candidate], { dataEpoch: actionEpoch });
  checkBrowserEpoch(actionEpoch);
  if (input.action === 'save') {
    const savedId = await saveCandidate(candidate, actionEpoch);
    notifyMemoryProcessingUpdated();
    return { state: 'saved', savedId };
  }
  if (input.action === 'discard') {
    if (candidate.origin === 'post') { const module = await import('../posts/baiyunPostMemoryRuntime'); checkBrowserEpoch(actionEpoch); await module.discardPostReviewCandidate(candidate, actionEpoch); }
    else if (candidate.origin === 'history_import') { const module = await import('./memoryHistoryImportStore'); checkBrowserEpoch(actionEpoch); await module.resolveStoredHistoryCandidate(candidate as import('./memoryHistoryImportStore').HistoryImportCandidate, 'discarded'); }
    else if (candidate.source === 'weekly-context') { const module = await import('./memoryWeeklyRefresh'); checkBrowserEpoch(actionEpoch); await module.discardWeeklyRefreshCandidate(candidate); }
    else await resolveMemoryIngestionItems(candidate.ingestionRefs ?? [], 'discarded', {
      expectedCandidate: { reviewId: candidate.reviewId, editableHash: memoryCandidateEditableHash(candidate) },
      dataEpoch: actionEpoch,
    });
    notifyMemoryProcessingUpdated();
    return { state: 'discarded' };
  }
  if (input.action === 'compare') {
    if (!input.targetHash) throw new Error('MEMORY_CANDIDATE_CHANGED');
    candidate = await acknowledgeMemoryCandidateTarget(candidate, input.targetHash);
  } else if (input.action === 'summary_check') {
    const module = await import('./memoryEpisodeReview'); checkBrowserEpoch(actionEpoch);
    candidate = await module.acknowledgeEpisodeSummaryCandidate(candidate);
  } else if (input.action === 'recheck') {
    if (candidate.shiyingBindings?.length) { const module = await import('../shiying/shiyingMemoryReview'); checkBrowserEpoch(actionEpoch); candidate = await module.recheckShiyingMemoryCandidate(candidate); }
    else if (candidate.readingBinding) { const module = await import('../reading/readingMemoryReview'); checkBrowserEpoch(actionEpoch); candidate = (await module.recheckReadingMemoryCandidate(candidate)).candidate; }
    else if (candidate.readingBindings?.length) { const module = await import('../reading/readingMemoryOrganizationReview'); checkBrowserEpoch(actionEpoch); candidate = await module.recheckReadingOrganizationCandidate(candidate); }
    else if (candidate.origin === 'post') {
      const module = await import('../posts/baiyunPostMemoryRuntime'); checkBrowserEpoch(actionEpoch);
      await module.organizePostMemory({ manual: true, recheck: candidate });
      const drafts = await (await import('../posts/baiyunPostMemoryRuntime')).loadPostReviewCandidates();
      const replacement = drafts.find(item => item.reviewId === candidate.reviewId || item.postBindings?.some(binding => candidate.postBindings?.some(original => original.postId === binding.postId)));
      if (!replacement) throw new Error('重新核对未生成对应稿，原输入保留。');
      candidate = replacement;
    } else if (candidate.currentStateReview) { const module = await import('./memoryCurrentStateReview'); checkBrowserEpoch(actionEpoch); candidate = await module.recheckCurrentStateCandidate(candidate); }
    else if (candidate.understandingSubject) {
      const module = await import('./memoryUnderstandingReview'); checkBrowserEpoch(actionEpoch);
      const next = await module.recheckUnderstanding(candidate);
      if (!next) throw new Error('重新核对没有生成新稿，原输入保留。');
      candidate = next;
    } else if (candidate.continuationReview || candidate.letterBindings?.length || candidate.observationBindings?.length) { const module = await import('./memoryEpisodeReview'); checkBrowserEpoch(actionEpoch); candidate = await module.recheckConversationMemoryCandidate(candidate); }
    else if (candidate.source === 'weekly-context') {
      const module = await import('./memoryWeeklyRefresh'); checkBrowserEpoch(actionEpoch);
      const next = await module.recheckWeeklyRefreshCandidate(candidate);
      if (!next) throw new Error('重新核对没有生成新稿，原输入保留。');
      candidate = next;
    } else throw new Error('这份草稿没有重新核对入口。');
  } else if (input.action !== 'edit') throw new Error('MEMORY_BROWSER_ACTION_INVALID');
  checkBrowserEpoch(actionEpoch);
  notifyMemoryProcessingUpdated();
  return { state: 'applied', detail: await readMemoryBrowserItem(`candidate:${candidate.reviewId}`) };
}
