import { JUNLUO_INNER_STATE_KEYS } from '../life/junluoInnerState';
import { upgradeJunluoDesireState } from '../life/junluoInnerStatePersistence';
import { assertAssistantLifeStateRecord, upgradeLegacyConversationAfterglowState } from '../sync/syncAssistantLifeState';
import { CONTACT_MOTIVES, contactLocalDay, initialContactState, type UnifiedContactState } from '../proactive/unifiedContact';
import { assertPrimaryChatBackupStorage } from '../chat/primaryChat';
import { emitChatDataChanged } from '../chat/chatDataChanges';
import { restoreExpensePlanCardsInStorage } from '../chat/chatExpensePlan';
import { restoreReminderPlanCardsInStorage } from '../chat/chatReminderPlan';
import { restoreDailyReadingProgress } from '../reading/readingDailyRestore';
import { restorePublicExplorationQuota } from '../life/publicExplorationQuota';
import { restoreDailyPlanningSettings } from '../life/autonomySettingsCompatibility';
import { restoreOwnDayPlanProgress } from '../schedule/ownDayPlanPolicy';
import { CHAT_CARE_CLEANUP_KEY, RETIRED_CARE_APPOINTMENTS_KEY, isChatCarePendingOperation } from '../ai/behavior/chatCareCleanup';
import { CONTINUITY_PENDING_OPERATION_STORAGE_KEY } from '../sync/syncContinuityPendingOperation';
import { prepareWishPoolBackupStorage } from '../wishPool/wishPoolBackupRestore';
import { AI_CALL_BUDGET_KEY, isRecentCostRecord, normalizeAiCallBudgetState, serializeAiCallBudgetState } from '../ai/aiCallBudgetStorage';
import { normalizeNearbyOutingState, pruneNearbyOutingState } from '../nearby/nearbyOuting';

export type BackupStorageEntry = [string, string];

export function prepareWantsPaperBackupStorage(storage: Record<string, string>, now = Date.now()) {
  const next = { ...storage };
  const desireRaw = next[JUNLUO_INNER_STATE_KEYS.desire];
  const desire = desireRaw === undefined ? null : upgradeJunluoDesireState(JSON.parse(desireRaw));
  if (desireRaw !== undefined && !desire) throw new Error('备份十维状态无法升级。');
  if (desire) next[JUNLUO_INNER_STATE_KEYS.desire] = JSON.stringify(desire);
  const bookmarkKey = 'junluo.assistant.conversationAfterglowState';
  if (next[bookmarkKey] !== undefined) {
    const bookmark = JSON.parse(next[bookmarkKey]);
    const current = bookmark?.schemaVersion === 3 ? bookmark
      : upgradeLegacyConversationAfterglowState(bookmark, now, desire?.recentProcessedOperations);
    assertAssistantLifeStateRecord('conversation-afterglow', 'conversation-afterglow', current);
    next[bookmarkKey] = JSON.stringify(current);
  }
  return next;
}

export type BackupStorageRestorePort = {
  multiGet(keys: string[]): Promise<ReadonlyArray<readonly [string, string | null]>>;
  multiRemove(keys: string[]): Promise<void>;
  multiSet(entries: BackupStorageEntry[]): Promise<void>;
};

// Restore changes the data epoch, but must not refund opportunities used on this phone.
function restoreRecentCostUse(current: Record<string, string>, restored: Record<string, string>, now: number) {
  const raw = current[AI_CALL_BUDGET_KEY];
  if (raw === undefined) return restored;
  const local = normalizeAiCallBudgetState(JSON.parse(raw), now).records.filter(record => isRecentCostRecord(record, now));
  if (!local.length) return restored;
  const incoming = restored[AI_CALL_BUDGET_KEY];
  const older = normalizeAiCallBudgetState(incoming === undefined ? undefined : JSON.parse(incoming), now);
  const localIds = new Set(local.map(record => record.id));
  return { ...restored, [AI_CALL_BUDGET_KEY]: serializeAiCallBudgetState({ version: 2,
    records: [...local, ...older.records.filter(record => !localIds.has(record.id))] }, now) };
}

function restoreProactiveRuntime(current: Record<string, string>, restored: Record<string, string>, now: number) {
  const key = 'junluo.proactiveMessage.state';
  if (current[key] === undefined && restored[key] === undefined) return restored;
  const read = (raw: string | undefined): Record<string, unknown> => {
    if (raw === undefined) return {};
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('主动联系备份记录无效。');
    return value as Record<string, unknown>;
  };
  const local = read(current[key]), incoming = read(restored[key]);
  const state = (record: Record<string, unknown>): UnifiedContactState | undefined => {
    if (record.unified === undefined) return undefined;
    const value = record.unified as UnifiedContactState;
    if (!value || value.version !== 1 || typeof value.day !== 'string'
      || !Number.isSafeInteger(value.used) || value.used < 0
      || !Number.isFinite(value.lastOrdinaryReplyAt)) throw new Error('主动联系备份进度无效。');
    const offer = value.lastOrdinaryCurrentStateOffer;
    if (offer !== undefined && (!offer || !Number.isFinite(offer.savedAt) || offer.savedAt < 0
      || ![offer.opportunityId, offer.sessionId, offer.messageId].every(item => typeof item === 'string' && item.length > 0)
      || offer.currentState !== null && (!offer.currentState
        || ![offer.currentState.id, offer.currentState.version].every(item => typeof item === 'string' && item.length > 0)))) {
      throw new Error('主动联系备份进度无效。');
    }
    return value;
  };
  const localState = state(local), incomingState = state(incoming);
  const day = contactLocalDay(now);
  const unified = initialContactState(now);
  unified.used = Math.max(localState?.day === day ? localState.used : 0,
    incomingState?.day === day ? incomingState.used : 0);
  unified.lastOrdinaryReplyAt = Math.max(localState?.lastOrdinaryReplyAt ?? 0,
    incomingState?.lastOrdinaryReplyAt ?? 0);
  const localOffer = localState?.lastOrdinaryCurrentStateOffer;
  for (const id of CONTACT_MOTIVES) {
    const at = Math.max(localState?.motiveLastSelectedAt?.[id] ?? 0, incomingState?.motiveLastSelectedAt?.[id] ?? 0);
    if (Number.isFinite(at) && at > 0) (unified.motiveLastSelectedAt ??= {})[id] = at;
  }
  const incomingOffer = incomingState?.lastOrdinaryCurrentStateOffer;
  const offer = localOffer && (!incomingOffer || localOffer.savedAt >= incomingOffer.savedAt) ? localOffer : incomingOffer;
  if (offer) unified.lastOrdinaryCurrentStateOffer = offer;
  // Only references to future real sources may open a new opportunity. Old drafts,
  // tool continuations and failure notes do not cross a restore boundary.
  return { ...restored, [key]: JSON.stringify({ ...(restored[key] === undefined ? local : incoming), unified }) };
}

const MAX_WRITE_BATCH_ENTRIES = 8;

// Existing local outing evidence is authoritative: importing an older archive must
// not restore pruned/deleted segments or replace an already adopted evidence version.
// A device without this format can import it; neither path restores sampling continuity.
function restoreOutingProgress(current: Record<string, string>, restored: Record<string, string>, now: number) {
  const key = 'junluo.nearbyWorld.activeEvents.v1';
  const parse = (raw: string | undefined) => raw === undefined ? undefined : JSON.parse(raw);
  const local = parse(current[key]), incoming = parse(restored[key]);
  const source = local?.outing ?? incoming?.outing;
  if (source !== undefined) {
    const outing = pruneNearbyOutingState(normalizeNearbyOutingState(source), now);
    const active = outing.current ? { ...outing.current } : undefined;
    if (active) delete active.homeSince;
    restored[key] = JSON.stringify({ ...(incoming ?? { queue: [], lastByKind: {} }),
      outing: { ...outing, samples: [], ...(active ? { current: active } : { current: undefined }) } });
  }
  const bookmarkKey = 'junluo.assistant.conversationAfterglowState';
  const localBookmark = parse(current[bookmarkKey]);
  const adopted = Object.fromEntries(Object.entries(localBookmark?.materials?.life ?? {})
    .filter(([id]) => id.startsWith('nearby-outing:')));
  if (Object.keys(adopted).length) {
    const bookmark = parse(restored[bookmarkKey]) ?? {
      schemaVersion: 3, paper: 'wants', activatedAt: now, updatedAt: now, cursors: {}, lateMessages: {},
      materials: { activatedAt: now, care: {}, hearts: [], life: {} },
    };
    assertAssistantLifeStateRecord('conversation-afterglow', 'conversation-afterglow', bookmark);
    bookmark.materials.life = { ...bookmark.materials.life, ...adopted };
    restored[bookmarkKey] = JSON.stringify(bookmark);
  }
  const bookmark = parse(restored[bookmarkKey]);
  if (bookmark) {
    const hasOutingRefs = (refs: unknown) => Array.isArray(refs) && refs.some(ref =>
      ref?.kind === 'life' && typeof ref.id === 'string' && ref.id.startsWith('nearby-outing:'));
    const invalidHosts = new Set(['pending', 'retry'].filter(field => hasOutingRefs(bookmark[field]?.materials))
      .map(field => bookmark[field].generationKey));
    const sharedInvalid = hasOutingRefs(bookmark.experience?.batch?.outingRefs);
    if (invalidHosts.size || sharedInvalid) {
      assertAssistantLifeStateRecord('conversation-afterglow', 'conversation-afterglow', bookmark);
      // A process epoch alone cannot invalidate a saved host after restart. Drop
      // only this feature's pre-restore hosts, not their unread evidence or read map.
      for (const field of ['pending', 'retry']) {
        if (invalidHosts.has(bookmark[field]?.generationKey)) delete bookmark[field];
      }
      if (sharedInvalid) delete bookmark.experience.batch;
      restored[bookmarkKey] = JSON.stringify(bookmark);
    }
  }
  return restored;
}
const MAX_WRITE_BATCH_CHARACTERS = 256 * 1024;
const MAX_READ_BATCH_ENTRIES = 16;
const MAX_REMOVE_BATCH_ENTRIES = 32;

function chunkEntries(entries: BackupStorageEntry[]) {
  const batches: BackupStorageEntry[][] = [];
  let batch: BackupStorageEntry[] = [];
  let batchCharacters = 0;

  for (const entry of entries) {
    const entryCharacters = entry[0].length + entry[1].length;
    if (
      batch.length > 0
      && (
        batch.length >= MAX_WRITE_BATCH_ENTRIES
        || batchCharacters + entryCharacters > MAX_WRITE_BATCH_CHARACTERS
      )
    ) {
      batches.push(batch);
      batch = [];
      batchCharacters = 0;
    }
    batch.push(entry);
    batchCharacters += entryCharacters;
  }

  if (batch.length > 0) batches.push(batch);
  return batches;
}

function chunkValues<T>(values: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function verifyWrittenEntries(
  storage: BackupStorageRestorePort,
  entries: BackupStorageEntry[],
) {
  for (const batch of chunkValues(entries, MAX_READ_BATCH_ENTRIES)) {
    const stored = new Map(await storage.multiGet(batch.map(([key]) => key)));
    for (const [key, expected] of batch) {
      if (stored.get(key) !== expected) {
        throw new Error(`备份数据写入后校验失败：${key}`);
      }
    }
  }
}

export async function replaceBackupStorageSafely(
  storage: BackupStorageRestorePort,
  currentStorage: Record<string, string>,
  restoredStorage: Record<string, string>,
  now = Date.now(),
) {
  assertPrimaryChatBackupStorage(restoredStorage);
  const normalizedStorage = restoreReminderPlanCardsInStorage(restoreExpensePlanCardsInStorage(restoreOutingProgress(currentStorage, prepareWishPoolBackupStorage(restoreDailyReadingProgress(
    currentStorage, restoreOwnDayPlanProgress(currentStorage,
      restoreProactiveRuntime(currentStorage, restoreRecentCostUse(currentStorage,
        restoreDailyPlanningSettings(currentStorage, restorePublicExplorationQuota(currentStorage, restoredStorage, now)), now), now), now), now,
  )), now)));
  // A backup restore invalidates the paid turn's host; an ordinary restart does not.
  const alarmKey = 'junluo.alarm.records.v1';
  if (normalizedStorage[alarmKey] !== undefined) {
    const alarms: unknown = JSON.parse(normalizedStorage[alarmKey]);
    if (!Array.isArray(alarms)) throw new Error('alarm-records-invalid');
    const local: unknown = currentStorage[alarmKey] === undefined ? [] : JSON.parse(currentStorage[alarmKey]);
    if (!Array.isArray(local)) throw new Error('alarm-records-invalid');
    const evidence = new Map(local.filter(record => record?.chatReminder?.kind === 'occurrence'
      && (record.status !== 'pending' || record.chatReminder.prepareClaim || record.chatReminder.chatDelivery
        || record.chatReminder.notificationEvidence || record.chatReminder.musicEvidence || record.chatReminder.musicControl))
      .map(record => [record.id, record]));
    const protectedSeries = new Set([...evidence.values()].map(record => record.chatReminder.seriesId));
    const currentSeries = new Map(local.filter(record => record?.chatReminder?.kind === 'series'
      && (protectedSeries.has(record.id) || record.status === 'cancelled')).map(record => [record.id, record]));
    let changed = false;
    const cleared = alarms.map(record => {
      if (record?.chatReminder?.kind === 'series' && currentSeries.has(record.id)) {
        changed = true;
        return currentSeries.get(record.id);
      }
      if (!record || typeof record !== 'object' || record.chatReminder?.kind !== 'occurrence') return record;
      // A restored older copy must not erase a real attempt on this phone.
      const actual = evidence.get(record.id);
      let selected = actual ? { ...actual } : record;
      const currentParent = currentSeries.get(selected.chatReminder.seriesId);
      if (selected.status === 'pending' && currentParent
        && (currentParent.status === 'cancelled' || selected.chatReminder.seriesRevision !== currentParent.chatReminder.revision)) {
        selected = { ...selected, status: 'cancelled' }; changed = true;
      }
      if (actual || selected.chatReminder.preparedBody) changed = true;
      if (!selected.chatReminder.preparedBody) return selected;
      const { preparedBody: _oldBody, ...metadata } = selected.chatReminder;
      return { ...selected, message: '', chatReminder: metadata };
    });
    // Keep the one already-created next occurrence of an evidence-protected
    // series, rather than restore a dangling nextOccurrenceId or regenerate it.
    const restoredIds = new Set(cleared.map(record => record?.id));
    for (const series of currentSeries.values()) {
      if (!restoredIds.has(series.id) || series.status === 'cancelled') continue;
      const nextId = series.chatReminder.nextOccurrenceId;
      const next = local.find(record => record.id === nextId && record.chatReminder?.kind === 'occurrence');
      if (next && !restoredIds.has(next.id)) {
        const { preparedBody: _oldBody, ...metadata } = next.chatReminder;
        cleared.push({ ...next, message: '', chatReminder: metadata }); changed = true;
      }
    }
    if (changed) normalizedStorage[alarmKey] = JSON.stringify(cleared);
  }
  const voyageKey = 'junluo.life.webVoyage.state.v1';
  if (normalizedStorage[voyageKey] !== undefined) {
    const state = JSON.parse(normalizedStorage[voyageKey]);
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('web-voyage-state-invalid');
    delete state.pending;
    normalizedStorage[voyageKey] = JSON.stringify(state);
  }
  for (const [key, raw] of Object.entries(normalizedStorage)) {
    if (!key.startsWith('junluo.assistant.lifeDay.')) continue;
    const day = JSON.parse(raw);
    if (day?.nearStatus?.continuation === undefined) continue;
    assertAssistantLifeStateRecord('life-day', day.dateKey, day);
    const { continuation: _continuation, ...run } = day.nearStatus;
    day.nearStatus = { ...run, outcome: 'interrupted', updatedAt: Math.max(now, run.updatedAt + 1) };
    normalizedStorage[key] = JSON.stringify(day);
  }
  delete normalizedStorage[RETIRED_CARE_APPOINTMENTS_KEY];
  normalizedStorage[CHAT_CARE_CLEANUP_KEY] = '3';
  const pending = normalizedStorage[CONTINUITY_PENDING_OPERATION_STORAGE_KEY];
  if (pending) {
    const value = JSON.parse(pending);
    if (isChatCarePendingOperation(value.logicalMutation ?? value)) delete normalizedStorage[CONTINUITY_PENDING_OPERATION_STORAGE_KEY];
  }
  const restoredEntries = Object.entries(normalizedStorage);
  for (const batch of chunkEntries(restoredEntries)) {
    await storage.multiSet(batch);
  }
  await verifyWrittenEntries(storage, restoredEntries);

  const obsoleteKeys = Object.keys(currentStorage).filter(
    (key) => !Object.prototype.hasOwnProperty.call(normalizedStorage, key),
  );
  for (const batch of chunkValues(obsoleteKeys, MAX_REMOVE_BATCH_ENTRIES)) {
    await storage.multiRemove(batch);
  }
  emitChatDataChanged('restore');

  return {
    obsoleteEntryCount: obsoleteKeys.length,
    restoredEntryCount: restoredEntries.length,
    restoredValueCharacters: restoredEntries.reduce(
      (total, [key, value]) => total + key.length + value.length,
      0,
    ),
  };
}
