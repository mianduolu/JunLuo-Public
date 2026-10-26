import { loadAiConfigPreferencesSnapshot } from '../ai/AiConfigPreferences';
import { runBudgetedAiCall } from '../ai/aiCallBudget';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { loadAutomaticRemoteAiPolicy } from '../runtime/automaticRemoteAiPolicy';
import { makeDerivedPeriodEventTime, stableMemoryHash } from './memoryAtomicity';
import { makeReviewCandidates, memoryCandidateEditableHash, type MemoryCandidateReview } from './memoryCandidateReview';
import { loadPendingMemoryCandidates, resolveMemoryIngestionItems, runMemoryCandidateSave, updatePendingMemoryCandidates } from './memoryIngestionService';
import { beginMemoryIngestionBatchWithDatabase, loadMemoryIngestionBatchWithDatabase, registerMemoryIngestionOutcomeWithDatabase, resolveMemoryIngestionItemsWithDatabase } from './memoryIngestionLedger';
import { loadPendingMemoryCandidatesWithDatabase } from './memoryCandidatePersistence';
import { runMemoryOrganizerRequestWithDeadline } from './memoryOrganizerRequestLifecycle';
import { blockMemoryProcessingJob, completeMemoryProcessingJobWithDatabase, deferMemoryProcessingJob, ensureWeeklyRefreshJobWithDatabase, hasPendingWeeklyCandidate, isMemoryProcessingLeaseCurrentWithDatabase, type MemoryProcessingJobLease } from './memoryProcessingQueue';
import { notifyMemoryProcessingWorkAvailable } from './memoryProcessingSignals';
import { runMemoryDuplicateCleanupDataEpochCommit } from './memoryDuplicateCleanupState';
import { collectWeeklyMaterials, getWeeklyContextStatus, isWeeklyCandidateCurrent, isWeeklyEpisode, isWeeklyMaterial, selectWeeklyMaterials, weeklyRangeFromKey, weeklyTargetHash, type WeeklyDatabase } from './memoryWeeklyBasis';
import { generateWeeklyContextCandidate, prepareWeeklyContextCandidate, type WeeklyContextPreparation } from './memoryWeeklyContext';
import { filterCurrentMemories, getMemoryDatabase, loadMemory, memoryFromRow, updateMemory, type MemoryEntry } from './memoryStore';
import { buildWeeklyMaterialText } from './memoryWeeklyMaterialText';
import { latestDueWeeklyPeriod } from './memoryWeeklySchedule';
import { clearWeeklyTaskIntent, loadWeeklyTaskIntent, saveWeeklyTaskIntent } from './memoryWeeklyTaskIntent';
import type { PostMemoryReadOptions } from '../posts/baiyunPostMemorySource';
export { latestDueWeeklyPeriod, nextWeeklyPeriodDueAt } from './memoryWeeklySchedule';

const listeners = new Set<() => void>();
export function subscribeWeeklyRefreshChanges(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function notifyWeeklyRefreshChanges() { for (const listener of listeners) { try { listener(); } catch { /* Commit already succeeded. */ } } }

export async function getWeeklyReviewStatus(memory: Parameters<typeof getWeeklyContextStatus>[1]) {
  return getWeeklyContextStatus(await getMemoryDatabase(), memory);
}

export async function loadWeeklyRefreshProgress(memoryId: string) {
  const job = await (await getMemoryDatabase()).getFirstAsync<{ state: string; last_error_code: string | null }>(
    "SELECT state, last_error_code FROM memory_processing_jobs WHERE target_kind = 'memory' AND memory_id = ? AND job_type = 'weekly_refresh'", memoryId);
  if (!job) return null;
  if (job.last_error_code === 'automatic_disabled') return '自动调用已关闭，任务等待恢复，也可以主动重新整理。';
  if (job.state === 'blocked') return '整理模型尚不可用，请检查配置；任务已保留。';
  if (job.state === 'failed') return '已达到本轮重试次数；任务保留，可主动重新整理。';
  if (job.state === 'leased') return '正在准备更新稿。';
  if (job.state === 'pending') {
    if (job.last_error_code === 'automatic_disabled') return '自动调用已关闭，任务等待恢复，也可以主动重新整理。';
    if (job.last_error_code?.startsWith('weekly_')) return '等待调用额度或后台间隔；任务已保留。';
    return job.last_error_code ? '上次整理未完成，等待重试；原记忆仍可搜索。' : '等待后台整理。';
  }
  const batch = await (await getMemoryDatabase()).getFirstAsync<{ status: string }>(
    'SELECT status FROM memory_ingestion_batches WHERE scope_key = ? ORDER BY updated_at DESC LIMIT 1', `weekly-refresh:${memoryId}`);
  if (batch?.status === 'no_value') return '当前材料未生成更新稿；材料变化或主动重试后再整理。';
  return null;
}

export async function loadWeeklyRefreshCandidates(memoryId?: string) {
  return loadPendingMemoryCandidates(memoryId ? { weeklyMemoryId: memoryId } : { weekly: true });
}

type WeeklyTarget = { memoryId: string; targetKind?: 'memory' | 'weekly_period' };

async function preloadWeeklyPostReadOptions(database: WeeklyDatabase): Promise<PostMemoryReadOptions> {
  const post = await database.getFirstAsync("SELECT 1 FROM memory_source_refs WHERE session_id LIKE 'post-source:%' LIMIT 1");
  return { knowledge: post ? await (await import('../posts/baiyunPostMemorySource')).loadPostMemoryKnowledgeSnapshot(database)
    : { reading: undefined, vision: [] } };
}

async function loadCanonicalWeeklyTargets(database: WeeklyDatabase, weekKey?: string) {
  const rows = await database.getAllAsync<{ id: string; date: string }>(`SELECT m.id, m.date FROM memories m
    WHERE m.source = 'weekly-context' AND m.type != 'archived' AND m.date IS NOT NULL
      ${weekKey ? 'AND m.date = ?' : ''}
    ORDER BY MAX(m.created_at,
      COALESCE((SELECT MAX(e.created_at) FROM memory_lifecycle_events e WHERE e.memory_id = m.id
        AND e.event_type IN ('created', 'confirmed', 'edited', 'corrected', 'organized')), 0),
      COALESCE((SELECT MAX(i.resolved_at) FROM memory_ingestion_items i WHERE i.memory_id = m.id AND i.status = 'saved'), 0)
    ) DESC, m.created_at DESC, m.id ASC`, ...(weekKey ? [weekKey] : []));
  const targets = new Map<string, string>();
  for (const row of rows) if (!targets.has(row.date)) targets.set(row.date, row.id);
  return targets;
}

async function loadWork(target: WeeklyTarget, inputDatabase?: WeeklyDatabase, snapshot?: MemoryEntry[],
  preparations = new Map<string, WeeklyContextPreparation | null>(), postOptions: PostMemoryReadOptions = {}) {
  const database = inputDatabase ?? await getMemoryDatabase();
  const memories = snapshot ?? (await database.getAllAsync<Parameters<typeof memoryFromRow>[0]>('SELECT * FROM memories')).map(memoryFromRow);
  const memory = target.targetKind === 'weekly_period' ? null : memories.find(item => item.id === target.memoryId);
  if (target.targetKind !== 'weekly_period' && (!memory || memory.source !== 'weekly-context' || memory.type === 'archived')) return null;
  const week = weeklyRangeFromKey(target.targetKind === 'weekly_period' ? target.memoryId : memory?.date);
  if (!week) return null;
  // A saved or archived card owns this period; a first-generation task cannot recreate it.
  if (!memory && memories.some(item => item.source === 'weekly-context' && item.date === week.key)) return null;
  if (!preparations.has(week.key)) preparations.set(week.key,
    await prepareWeeklyContextCandidate({ weekKey: week.key, replacing: true, memories, database, postOptions }));
  const preparation = preparations.get(week.key)!;
  const targetHash = memory ? weeklyTargetHash(memory) : undefined;
  const desiredHash = stableMemoryHash(JSON.stringify([targetHash ?? null, preparation?.sourceHash ?? null]));
  return { memory: memory ?? null, week, targetHash, desiredHash, preparation };
}

export async function requeueWeeklyRefreshJob(lease: MemoryProcessingJobLease, dataEpoch: number) {
  await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
    const database = await getMemoryDatabase();
    const postOptions = await preloadWeeklyPostReadOptions(database);
    await database.withExclusiveTransactionAsync(async transaction => {
      const targetKind = lease.targetKind === 'weekly_period' ? 'weekly_period' : 'memory';
      const work = await loadWork({ ...lease, targetKind }, transaction, undefined, undefined, postOptions);
      if (work) {
        if (!await isMemoryProcessingLeaseCurrentWithDatabase(transaction, lease)) return;
        await deferMemoryProcessingJob(transaction, lease, 'weekly_material_changed', Date.now());
        await ensureWeeklyRefreshJobWithDatabase(transaction, lease.memoryId, work.desiredHash, false, targetKind);
      }
      else await completeMemoryProcessingJobWithDatabase(transaction, lease);
    });
  });
}

export async function reconcileWeeklyRefreshJobs(now = Date.now()) {
  const dataEpoch = captureBackupRestoreDataEpoch();
  if (dataEpoch === null) return;
  const database = await getMemoryDatabase();
  if (await hasPendingWeeklyCandidate(database)) return;
  const automatic = (await loadAutomaticRemoteAiPolicy()).enabled;
  const postOptions = await preloadWeeklyPostReadOptions(database);
  // Full-corpus discovery and preparation must yield between reads to chat.
  // Only the inputs for one planned week are rechecked while holding the writer.
  const memories = (await database.getAllAsync<Parameters<typeof memoryFromRow>[0]>('SELECT * FROM memories')).map(memoryFromRow);
  const preparations = new Map<string, WeeklyContextPreparation | null>();
  const latest = latestDueWeeklyPeriod(now).weekKey;
  const canonical = await loadCanonicalWeeklyTargets(database);
  const statuses = new Map<string, boolean>();
  const plans = new Map<string, { work: NonNullable<Awaited<ReturnType<typeof loadWork>>>; target: WeeklyTarget }[]>();
  const targets: WeeklyTarget[] = [{ targetKind: 'weekly_period', memoryId: latest }, ...memories
    .filter(memory => memory.source === 'weekly-context' && memory.type !== 'archived' && memory.weeklyContextBasis)
    .map(memory => ({ targetKind: 'memory' as const, memoryId: memory.id }))];
  for (const target of targets) {
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    const work = await loadWork(target, database, memories, preparations, postOptions);
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    if (!work) continue;
    if (work.memory && (work.memory.weeklyContextBasis?.sourceHash === work.preparation?.sourceHash
      || (!work.preparation && await getWeeklyContextStatus(database, work.memory, postOptions) === 'current'))) continue;
    if (work.memory && canonical.get(work.week.key) !== work.memory.id) {
      const basisKey = JSON.stringify([work.memory.date, work.memory.weeklyContextBasis]);
      if (!statuses.has(basisKey)) statuses.set(basisKey, await getWeeklyContextStatus(database, work.memory, postOptions) === 'current');
      if (statuses.get(basisKey)) continue;
    }
    const plan = plans.get(work.week.key) ?? [];
    plan.push({ work, target }); plans.set(work.week.key, plan);
  }
  for (const plan of plans.values()) {
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    const { week, preparation } = plan[0].work;
    const candidates = memories.filter(memory => isWeeklyMaterial(memory, week));
    const inputHash = (items: MemoryEntry[]) => stableMemoryHash(JSON.stringify(items
      .map(memory => [memory.id, weeklyTargetHash(memory)]).sort((left, right) => left[0].localeCompare(right[0]))));
    const expectedInputs = inputHash(candidates);
    const currentPostOptions = await preloadWeeklyPostReadOptions(database);
    const committed = await runBackupRestoreDataEpochCommit(dataEpoch, () => database.withExclusiveTransactionAsync(async transaction => {
      if (await hasPendingWeeklyCandidate(transaction)) return;
      // Include every possible occurrence in this week, including previously
      // ineligible/new cards; checking only the chosen 18 misses ranking changes.
      const currentCandidates = (await transaction.getAllAsync<Parameters<typeof memoryFromRow>[0]>(
        'SELECT * FROM memories WHERE event_start_at >= ? AND event_start_at < ?', week.start, week.end))
        .map(memoryFromRow).filter(memory => isWeeklyMaterial(memory, week));
      if (inputHash(currentCandidates) !== expectedInputs) return;
      const current = await filterCurrentMemories(transaction, currentCandidates, currentPostOptions);
      const end = new Date(week.end - 1);
      const endKey = [end.getFullYear(), String(end.getMonth() + 1).padStart(2, '0'), String(end.getDate()).padStart(2, '0')].join('-');
      const weekLabel = `${week.key} 至 ${endKey}`;
      const selected = buildWeeklyMaterialText(selectWeeklyMaterials(current, week), [], weekLabel).materials;
      // Keep preparation's sufficiency rule. Recheck only this week's selection
      // and basis; never rediscover the corpus or prepare a model request here.
      const enough = selected.some(isWeeklyEpisode) || selected.filter(memory => memory.importance >= 6).length >= 5;
      const sourceHash = enough ? (await collectWeeklyMaterials(transaction, selected, week)).basis.sourceHash : null;
      if (sourceHash !== (preparation?.sourceHash ?? null)) return;
      const currentTargets = (await transaction.getAllAsync<Parameters<typeof memoryFromRow>[0]>(
        "SELECT * FROM memories WHERE source = 'weekly-context' AND date = ?", week.key)).map(memoryFromRow);
      const currentCanonical = (await loadCanonicalWeeklyTargets(transaction, week.key)).get(week.key);
      if (currentCanonical !== canonical.get(week.key)) return;
      for (const { work, target } of plan) {
        const memory = currentTargets.find(item => item.id === target.memoryId);
        if (target.targetKind === 'weekly_period' ? currentTargets.length > 0
          : !memory || memory.type === 'archived' || weeklyTargetHash(memory) !== work.targetHash) return;
      }
      const jobs = await transaction.getAllAsync<{ target_kind: string; memory_id: string; state: string; desired_hash: string }>(
        "SELECT target_kind, memory_id, state, desired_hash FROM memory_processing_jobs WHERE job_type = 'weekly_refresh' AND memory_id IN (SELECT value FROM json_each(?))",
        JSON.stringify(plan.map(item => item.target.memoryId)));
      const currentStatuses = new Map<string, boolean>();
      for (const { work, target } of plan) {
        const job = jobs.find(item => item.target_kind === (target.targetKind ?? 'memory') && item.memory_id === target.memoryId);
        if (job && (job.state === 'leased' || job.desired_hash === work.desiredHash)) continue;
        // An old valid duplicate cannot acquire new selection when canonical
        // ownership or its old evidence changed while preparation was outside.
        if (work.memory && (work.preparation === null || currentCanonical !== work.memory.id)) {
          const basisKey = JSON.stringify([work.memory.date, work.memory.weeklyContextBasis]);
          if (!currentStatuses.has(basisKey)) currentStatuses.set(basisKey,
            await getWeeklyContextStatus(transaction, work.memory, currentPostOptions) === 'current');
          if (currentStatuses.get(basisKey)) continue;
        }
        const created = await ensureWeeklyRefreshJobWithDatabase(transaction, target.memoryId, work.desiredHash, false, target.targetKind);
        if (created && target.targetKind === 'weekly_period') await transaction.runAsync(
          "UPDATE memory_processing_jobs SET last_error_code = 'weekly_automatic_period' WHERE target_kind = 'weekly_period' AND memory_id = ? AND state = 'pending'", target.memoryId);
      }
    }));
    if (!committed.committed) return;
  }
  await runBackupRestoreDataEpochCommit(dataEpoch, () => database.withExclusiveTransactionAsync(async transaction => {
    if (await hasPendingWeeklyCandidate(transaction)) return;
    // Unstarted automatic first drafts older than the latest due period are not a backlog.
    await transaction.runAsync(`DELETE FROM memory_processing_jobs WHERE target_kind = 'weekly_period' AND memory_id != ?
      AND state != 'leased' AND state != 'completed' AND NOT EXISTS (SELECT 1 FROM memory_ingestion_batches b
        WHERE b.id = 'weekly-task:weekly_period:' || memory_processing_jobs.memory_id AND b.work_metadata_json IS NOT NULL)`, latest);
    if (automatic) await transaction.runAsync(
      "UPDATE memory_processing_jobs SET state = 'pending', available_at = ?, last_error_code = NULL WHERE job_type = 'weekly_refresh' AND state = 'blocked' AND last_error_code = 'automatic_disabled'", now);
  }));
}

function matchesWeeklyReplacement(pending: MemoryCandidateReview[], replacing: MemoryCandidateReview) {
  return pending.length >= 1 && pending[0].reviewId === replacing.reviewId
    && memoryCandidateEditableHash(pending[0]) === memoryCandidateEditableHash(replacing)
    && JSON.stringify([pending[0].weeklyRefresh, pending[0].weeklyContextBasis, pending[0].sourceRefs])
      === JSON.stringify([replacing.weeklyRefresh, replacing.weeklyContextBasis, replacing.sourceRefs]);
}

const weeklyRechecks = new Map<string, { hash: string; promise: Promise<MemoryCandidateReview> }>();
export function recheckWeeklyRefreshCandidate(candidate: MemoryCandidateReview) {
  const dataEpoch = captureBackupRestoreDataEpoch();
  const memoryId = candidate.weeklyRefresh?.memoryId;
  const key = memoryId ?? candidate.weeklyContextBasis?.weekKey;
  if (!key) return Promise.reject(new Error('原周回顾已不存在，输入已保留。'));
  const hash = memoryCandidateEditableHash(candidate);
  const active = weeklyRechecks.get(key);
  if (active) return active.hash === hash ? active.promise : Promise.reject(new Error('草稿已改变，请保留输入后重试。'));
  const promise = (async () => {
    await updatePendingMemoryCandidates([candidate]);
    const pending = await loadWeeklyRefreshCandidates();
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) throw new Error('数据正在恢复，原输入已保留。');
    if (!matchesWeeklyReplacement(pending, candidate)) throw new Error('草稿已改变，请保留输入后重试。');
    if (pending[0].reviewStatus === 'current') return pending[0];
    if (memoryId) await requestWeeklyRefresh(memoryId, pending[0]);
    else await requestWeeklyPeriod(key, pending[0]);
    const updated = await loadWeeklyRefreshCandidates();
    const next = !updated.some(item => item.reviewId === candidate.reviewId)
      && updated[0]?.weeklyContextBasis?.weekKey === candidate.weeklyContextBasis?.weekKey
      && (!memoryId || updated[0]?.weeklyRefresh?.memoryId === memoryId) ? updated[0] : undefined;
    if (!next) throw new Error('本次尚未准备好新稿，原输入已保留；可以稍后重新整理。');
    return next;
  })();
  weeklyRechecks.set(key, { hash, promise });
  void promise.finally(() => { if (weeklyRechecks.get(key)?.promise === promise) weeklyRechecks.delete(key); }).catch(() => undefined);
  return promise;
}

export async function requestWeeklyRefresh(memoryId: string, replacingCandidate?: MemoryCandidateReview) {
  return requestWeeklyTarget({ memoryId, targetKind: 'memory' }, replacingCandidate);
}

export async function requestWeeklyPeriod(weekKey: string, replacingCandidate?: MemoryCandidateReview) {
  if (!weeklyRangeFromKey(weekKey) || weekKey > latestDueWeeklyPeriod().weekKey) throw new Error('周范围无效，暂时只能整理已经到期的周。');
  const database = await getMemoryDatabase();
  const id = (await loadCanonicalWeeklyTargets(database)).get(weekKey);
  return requestWeeklyTarget({ memoryId: id ?? weekKey, targetKind: id ? 'memory' : 'weekly_period' }, replacingCandidate);
}

export async function loadWeeklyPeriodProgress(weekKey: string) {
  const database = await getMemoryDatabase();
  const id = (await loadCanonicalWeeklyTargets(database)).get(weekKey);
  if (id) return loadWeeklyRefreshProgress(id);
  const job = await database.getFirstAsync<{ state: string; last_error_code: string | null }>(
    "SELECT state,last_error_code FROM memory_processing_jobs WHERE target_kind = 'weekly_period' AND memory_id = ? AND job_type = 'weekly_refresh'", weekKey);
  if (!job) return null;
  if (job.last_error_code === 'automatic_disabled') return '自动调用已关闭，任务等待恢复，也可以主动重新整理。';
  if (job.state === 'blocked') return '整理模型尚不可用，请检查配置；任务已保留。';
  if (job.state === 'failed') return '已达到本轮重试次数；任务保留，可主动重新整理。';
  if (job.state === 'leased') return '正在准备周回顾。';
  if (job.state === 'pending') return job.last_error_code ? '上次整理未完成，等待重试；任务已保留。' : '等待后台整理。';
  const batch = await database.getFirstAsync<{ status: string }>(
    'SELECT status FROM memory_ingestion_batches WHERE scope_key = ? ORDER BY updated_at DESC LIMIT 1', `week:${weekKey}`);
  return batch?.status === 'no_value' ? '当前材料未生成周回顾；材料变化或主动重试后再整理。' : null;
}

async function requestWeeklyTarget(target: WeeklyTarget, replacingCandidate?: MemoryCandidateReview) {
  const dataEpoch = captureBackupRestoreDataEpoch();
  const work = await loadWork(target);
  if (!work) throw new Error('这篇回顾没有可整理的有效周范围，或已归档。');
  const pending = await loadWeeklyRefreshCandidates();
  if (replacingCandidate) {
    if (!matchesWeeklyReplacement(pending, replacingCandidate) || work.week.key !== replacingCandidate.weeklyContextBasis?.weekKey) {
      throw new Error('原卡或草稿已改变，输入已保留；请重新查看。');
    }
  } else if (pending.some(candidate => target.targetKind === 'weekly_period'
    ? !candidate.weeklyRefresh && candidate.weeklyContextBasis?.weekKey === target.memoryId
    : candidate.weeklyRefresh?.memoryId === target.memoryId)) return pending;
  const commit = await runMemoryDuplicateCleanupDataEpochCommit(dataEpoch, async () => {
    const database = await getMemoryDatabase();
    const postOptions = await preloadWeeklyPostReadOptions(database);
    await database.withExclusiveTransactionAsync(async transaction => {
      const currentWork = await loadWork(target, transaction, undefined, undefined, postOptions);
      if (!currentWork) throw new Error('这篇回顾没有可整理的有效周范围，或已归档。');
      const active = await transaction.getFirstAsync<{ state: string; desired_hash: string }>(
        "SELECT state,desired_hash FROM memory_processing_jobs WHERE target_kind = ? AND memory_id = ? AND job_type = 'weekly_refresh'", target.targetKind ?? 'memory', target.memoryId);
      // Repeated clicks cannot supersede an identical request already in flight.
      if (!(active?.state === 'leased' && active.desired_hash === currentWork.desiredHash)) {
        await saveWeeklyTaskIntent(transaction, target, { token: `${Date.now()}-${Math.random().toString(36).slice(2)}`, replacingCandidate });
      }
      await ensureWeeklyRefreshJobWithDatabase(transaction, target.memoryId, currentWork.desiredHash, true, target.targetKind);
    });
  });
  if (!commit.committed) throw new Error('数据正在恢复，请稍后重新整理。');
  notifyMemoryProcessingWorkAvailable('memory_changed');
  const { runWeeklyRefreshManually } = await import('./memoryProcessingWorker');
  await runWeeklyRefreshManually(target.memoryId, replacingCandidate, dataEpoch, target.targetKind);
  notifyWeeklyRefreshChanges();
  const job = await (await getMemoryDatabase()).getFirstAsync<{ state: string; last_error_code: string | null }>(
    "SELECT state, last_error_code FROM memory_processing_jobs WHERE target_kind = ? AND memory_id = ? AND job_type = 'weekly_refresh'", target.targetKind ?? 'memory', target.memoryId);
  if (job?.state === 'blocked') throw new Error('整理暂不可用，请检查记忆整理模型配置；任务已保留。');
  if (job?.state === 'failed') throw new Error('整理多次失败，任务已保留，可以稍后重新整理。');
  const candidates = await loadWeeklyRefreshCandidates();
  if (job?.state === 'completed' && !candidates.length) {
    throw new Error('当前材料不足以生成更新稿；原回顾仍保留在历史中。');
  }
  return candidates;
}

export async function processWeeklyRefreshJob(lease: MemoryProcessingJobLease, dataEpoch: number, manual = false, replacingCandidate?: MemoryCandidateReview) {
  const database = await getMemoryDatabase();
  const targetKind = lease.targetKind === 'weekly_period' ? 'weekly_period' : 'memory';
  const target = { memoryId: lease.memoryId, targetKind } as const;
  const intent = await loadWeeklyTaskIntent(database, target);
  manual ||= !!intent;
  replacingCandidate ??= intent?.replacingCandidate;
  const work = await loadWork(target);
  if (!work) return completeMemoryProcessingJobWithDatabase(database, lease);
  // A changed source must not silently replace an edited pending draft.
  const pendingDrafts = await loadWeeklyRefreshCandidates();
  const replacing = manual ? replacingCandidate : undefined;
  if (replacing && (!matchesWeeklyReplacement(pendingDrafts, replacing) || work.week.key !== replacing.weeklyContextBasis?.weekKey)) throw new Error('MEMORY_CANDIDATE_CHANGED');
  if (pendingDrafts.length && !replacing) {
    await deferMemoryProcessingJob(database, lease, 'weekly_review_pending', Date.now());
    return false;
  }
  if (work.desiredHash !== lease.desiredHash) {
    await requeueWeeklyRefreshJob(lease, dataEpoch);
    return false;
  }
  if (work.preparation && !manual && !(await loadAutomaticRemoteAiPolicy()).enabled) {
    await blockMemoryProcessingJob(database, lease, 'automatic_disabled');
    return false;
  }
  const scopeKey = targetKind === 'weekly_period' ? `week:${work.week.key}` : `weekly-refresh:${lease.memoryId}`;
  let batchId = targetKind === 'weekly_period'
    ? `memory-ingestion-weekly-${stableMemoryHash(`${scopeKey}\u0000${work.preparation?.sourceHash ?? lease.desiredHash}`)}`
    : `weekly-refresh-${stableMemoryHash(`${lease.memoryId}\u0000${lease.desiredHash}`)}`;
  const itemKey = `weekly-${lease.desiredHash}${intent ? `-${intent.token}` : ''}`;
  let previous = await loadMemoryIngestionBatchWithDatabase(database, batchId);
  if (manual && (previous?.status === 'resolved' || previous?.status === 'no_value')) {
    if (await database.getFirstAsync("SELECT 1 FROM memory_ingestion_items WHERE batch_id = ? AND status = 'saved' LIMIT 1", batchId)) {
      // A fresh manual attempt gets its own outcome without rewriting saved invitation receipts.
      batchId += `-manual-${intent?.token ?? lease.leaseId}`;
      previous = await loadMemoryIngestionBatchWithDatabase(database, batchId);
    }
    // Explicit retry reopens only unsuccessful outcomes; saved receipts remain immutable.
    await database.runAsync(`UPDATE memory_ingestion_batches SET status = 'pending', completed_at = NULL
      WHERE id = ? AND NOT EXISTS (SELECT 1 FROM memory_ingestion_items WHERE batch_id = ? AND status = 'saved')`, batchId, batchId);
  }
  const outcome = manual ? await loadMemoryIngestionBatchWithDatabase(database, batchId) : previous;
  if (outcome?.status === 'resolved' || outcome?.status === 'no_value'
    || (await loadPendingMemoryCandidates({ batchIds: [batchId] })).length) {
    await clearWeeklyTaskIntent(database, target, intent);
    return completeMemoryProcessingJobWithDatabase(database, lease);
  }
  const preparation = work.preparation;
  let candidate: MemoryCandidateReview | undefined;
  if (preparation) {
    const config = await loadAiConfigPreferencesSnapshot({ maxAgeMs: 0 });
    if (!config.memoryOrganizerConnection || !config.memoryOrganizerKey.trim()) {
      await blockMemoryProcessingJob(database, lease, 'memory_organizer_configuration');
      return false;
    }
    const generated = await runBudgetedAiCall('memoryWeeklyRefresh', manual ? 'normal' : 'background',
      () => runMemoryOrganizerRequestWithDeadline(signal => generateWeeklyContextCandidate({
        apiKey: config.memoryOrganizerKey, connection: config.memoryOrganizerConnection!,
      }, { preparation, signal })), { connection: config.memoryOrganizerConnection, dataEpoch });
    if (generated.ok === false) {
      const retryAt = generated.retryAfter ?? Date.now() + 60_000;
      await deferMemoryProcessingJob(database, lease, `weekly_${generated.reason}`, retryAt);
      // One organizer budget applies to every automatic week. Do not discover the
      // same deadline separately for fifty jobs while explicit requests can still take over.
      if (!manual) await database.runAsync(`UPDATE memory_processing_jobs SET available_at = MAX(available_at, ?)
        WHERE job_type = 'weekly_refresh' AND state = 'pending' AND NOT EXISTS (
          SELECT 1 FROM memory_ingestion_batches b WHERE b.id = 'weekly-task:' || memory_processing_jobs.target_kind || ':' || memory_processing_jobs.memory_id
            AND b.work_metadata_json IS NOT NULL)`, retryAt);
      return false;
    }
    if (generated.value) {
      [candidate] = makeReviewCandidates([generated.value], 'weekly', {
        sourceStartAt: preparation.week.start, sourceEndAt: preparation.week.end,
      });
      if (work.memory) Object.assign(candidate, {
        pinned: work.memory.pinned, anchor: work.memory.anchor, anchorKind: work.memory.anchorKind,
        protected: work.memory.protected, type: work.memory.type, tier: work.memory.tier,
        resolved: work.memory.resolved, digested: work.memory.digested,
        surfaceMutedAt: work.memory.surfaceMutedAt,
      });
      if (work.memory) candidate.weeklyRefresh = { memoryId: work.memory.id, targetHash: work.targetHash!,
        previousTitle: work.memory.title, previousContent: work.memory.content };
      candidate.ingestionRefs = [{ batchId, itemKey }];
    }
  }
  let completed = false;
  const postOptions = await preloadWeeklyPostReadOptions(database);
  const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
    await database.withExclusiveTransactionAsync(async transaction => {
      if (!await isMemoryProcessingLeaseCurrentWithDatabase(transaction, lease)
        || lease.leaseExpiresAt <= Date.now()) return;
      const finalWork = await loadWork(target, transaction, undefined, undefined, postOptions);
      if (!finalWork || finalWork.desiredHash !== lease.desiredHash) throw new Error('MEMORY_WEEKLY_STALE');
      if (candidate && !(await isWeeklyCandidateCurrent(transaction, candidate, postOptions))) throw new Error('MEMORY_WEEKLY_STALE');
      const pending = await loadPendingMemoryCandidatesWithDatabase(transaction, { weekly: true });
      if (replacing && !matchesWeeklyReplacement(pending, replacing)) throw new Error('MEMORY_CANDIDATE_CHANGED');
      if (pending.length && !replacing) { await deferMemoryProcessingJob(transaction, lease, 'weekly_review_pending', Date.now()); return; }
      await beginMemoryIngestionBatchWithDatabase(transaction, {
        id: batchId, scopeKey, sourceHash: lease.desiredHash, stream: 'weekly', advancesCursor: false,
      });
      const originalCreatedAt = replacing ? await transaction.getFirstAsync<{ created_at: number }>(
        "SELECT MIN(created_at) AS created_at FROM memory_ingestion_items WHERE status = 'pending' AND json_extract(candidate_json, '$.reviewId') = ?", replacing.reviewId) : null;
      // A manual recheck replaces the old input only together with a usable new
      // proposal. No result, failed requests and late edits keep the draft intact.
      if (candidate && replacing) await resolveMemoryIngestionItemsWithDatabase(transaction, replacing.ingestionRefs ?? [], 'suppressed');
      await registerMemoryIngestionOutcomeWithDatabase(transaction, {
        batchId, pendingItemKeys: candidate ? [itemKey] : [],
        pendingCandidates: candidate ? [{ itemKey, candidateJson: JSON.stringify(candidate) }] : [],
      });
      if (candidate && originalCreatedAt?.created_at !== undefined) await transaction.runAsync(
        'UPDATE memory_ingestion_items SET created_at = ? WHERE batch_id = ? AND item_key = ?', originalCreatedAt.created_at - 1, batchId, itemKey);
      completed = await completeMemoryProcessingJobWithDatabase(transaction, lease);
      if (completed) await clearWeeklyTaskIntent(transaction, target, intent);
    });
  });
  if (committed.committed) notifyWeeklyRefreshChanges();
  return committed.committed && completed;
}

export function saveWeeklyRefreshCandidate(candidate: MemoryCandidateReview) {
  return runMemoryCandidateSave(candidate, async (stored, dataEpoch) => {
  if (!stored?.weeklyRefresh || !stored.weeklyContextBasis) throw new Error('这份更新稿的依据已改变，请重新整理。');
  const current = await loadMemory(stored.weeklyRefresh.memoryId);
  if (!current) throw new Error('原回顾已不存在。');
  const basis = stored.weeklyContextBasis;
  const result = await runBackupRestoreDataEpochCommit(dataEpoch, () => updateMemory(current.id, {
    ...current, ...stored, date: basis.weekKey,
    eventTime: makeDerivedPeriodEventTime(basis.startAt, basis.endAt - 1),
    eventAt: basis.startAt, source: 'weekly-context',
  }, {
    confirmationLevel: 'reviewed', sourceRefs: stored.sourceRefs, ingestionResolutions: stored.ingestionRefs,
    weeklyExpectedTargetHash: stored.weeklyRefresh!.targetHash,
    requirePendingIngestion: true, dataEpoch,
    ingestionExpectedCandidate: { reviewId: stored.reviewId, editableHash: memoryCandidateEditableHash(stored) },
  }));
  if (!result.committed) throw new Error('数据正在恢复，请稍后确认。');
  notifyWeeklyRefreshChanges();
  notifyMemoryProcessingWorkAvailable('memory_changed');
  return current.id;
  });
}

export async function discardWeeklyRefreshCandidate(candidate: MemoryCandidateReview) {
  await resolveMemoryIngestionItems(candidate.ingestionRefs ?? [], 'discarded', {
    expectedCandidate: { reviewId: candidate.reviewId, editableHash: memoryCandidateEditableHash(candidate) },
  });
  notifyWeeklyRefreshChanges();
  notifyMemoryProcessingWorkAvailable('memory_changed');
}
