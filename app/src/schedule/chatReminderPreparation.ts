import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { buildCompiledSystemPrompt } from '../ai/builtInSystemPrompt';
import { loadAiConfigPreferencesSnapshot } from '../ai/AiConfigPreferences';
import { runBudgetedAiCall } from '../ai/aiCallBudget';
import { beginPromptCacheMetric } from '../ai/promptCacheMetrics';
import { normalizeVisibleReplyRaw } from '../ai/visibleReplyExtraction';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { loadPrimaryChatSession, loadChatSessionMessage } from '../chat/chatStorage';
import { PRIMARY_CHAT_SESSION_ID } from '../chat/primaryChat';
import { hasActiveChatReplyBackground } from '../chat/chatReplyBackground';
import { loadAutomaticRemoteAiPolicy } from '../runtime/automaticRemoteAiPolicy';
import { loadChatReminderOccurrences, getChatReminderOccurrence, updateChatReminderOccurrence, type ChatReminderOccurrenceRecord } from './chatReminderStore';
import { mutateAlarmRecords } from './alarmStore';
import { reminderNormalConversation, reminderConversationRevision, loadReminderConversationRevision } from './chatReminderConversation';
import { REMINDER_BODY_INSTRUCTION } from '../tools/chatReminderTools';
import { canUseChatReminder } from './chatReminderSong';
import { loadJunluoDesirePromptPaper } from '../life/junluoDesireRuntime';
import { estimateApiMessagesTokens, getReplyTokenReserve } from '../chat/contextCompression';

export const CHAT_REMINDER_PREPARE_MS = 15 * 60_000;
export type StandaloneReminderBatch = { records: ChatReminderOccurrenceRecord[]; conversationRevision: string;
  packet: string; instruction: string };
function visible(records: readonly ChatReminderOccurrenceRecord[]) {
  return records.map((record, index) => ({ item: index + 1, title: record.title,
    time: new Date(record.triggerAt).toLocaleString('zh-CN', { hour12: false }), mode: record.chatReminder.mode,
    ...(record.chatReminder.note ? { note: record.chatReminder.note } : {}),
    ...(record.musicSong ? { song: { title: record.musicSong.name, artist: record.musicSong.artist } } : {}) }));
}
function makeBatch(records: ChatReminderOccurrenceRecord[], conversationRevision: string): StandaloneReminderBatch {
  const packet = () => JSON.stringify({ reminders: visible(records) });
  while (records.length && packet().length > 6500) records.pop();
  return { records, conversationRevision, packet: records.length ? packet() : '', instruction: records.length ? REMINDER_BODY_INSTRUCTION : '' };
}
export async function prepareStandaloneReminderBatch(now = Date.now()): Promise<StandaloneReminderBatch> {
  const conversationRevision = await loadReminderConversationRevision();
  if (!await canUseChatReminder()) return makeBatch([], conversationRevision);
  const records = (await loadChatReminderOccurrences()).filter(record => record.status === 'pending'
    && record.triggerAt > now && record.triggerAt <= now + CHAT_REMINDER_PREPARE_MS
    && !record.chatReminder.chatDelivery
    && (!record.chatReminder.preparedBody || record.chatReminder.preparedBody.conversationRevision !== conversationRevision))
    .sort((a, b) => a.triggerAt - b.triggerAt || a.id.localeCompare(b.id)).slice(0, 5);
  return makeBatch(records, conversationRevision);
}
export function transmittedStandaloneReminderBatch(batch: StandaloneReminderBatch, materials: readonly string[]) {
  return batch.records.length && materials.some(material => material.includes(batch.packet) && material.includes(REMINDER_BODY_INSTRUCTION)) ? batch : undefined;
}
export async function standaloneReminderBatchCurrent(batch: StandaloneReminderBatch) {
  if (!batch.records.length) return true;
  if (await loadReminderConversationRevision() !== batch.conversationRevision) return false;
  for (const expected of batch.records) {
    const current = await getChatReminderOccurrence(expected.id);
    if (!current || current.status !== 'pending' || current.triggerAt <= Date.now()
      || current.chatReminder.attemptId !== expected.chatReminder.attemptId
      || current.chatReminder.revision !== expected.chatReminder.revision || current.chatReminder.chatDelivery) return false;
  }
  return true;
}
export async function commitStandaloneReminderAnswer(raw: string, batch: StandaloneReminderBatch | undefined,
  input: { dataEpoch: number; isCurrent: () => boolean | Promise<boolean>; savedReplyIds?: readonly string[] }) {
  if (!batch?.records.length || !canCommitBackupRestoreDataEpoch(input.dataEpoch) || !await input.isCurrent()) return;
  let answer: unknown;
  let parseError = '';
  try { answer = JSON.parse(normalizeVisibleReplyRaw(raw)).reminderMessages; } catch { parseError = raw ? 'REMINDER_ANSWER_PARSE_FAILED' : 'REMINDER_REQUEST_FAILED'; }
  const selected = new Map<number, string>();
  const errors = new Map<number, string>();
  if (Array.isArray(answer)) for (const value of answer) {
    if (value && typeof value === 'object' && Number.isInteger(value.item) && value.item >= 1
      && value.item <= batch.records.length) {
      if (selected.has(value.item) || errors.has(value.item)) { selected.delete(value.item); errors.set(value.item, 'REMINDER_BODY_DUPLICATE'); continue; }
      if (typeof value.text === 'string' && value.text.length <= 4000) selected.set(value.item, value.text);
      else errors.set(value.item, value.text === null ? 'REMINDER_BODY_NULL' : value.text === undefined ? 'REMINDER_BODY_MISSING' : 'REMINDER_BODY_INVALID_TYPE_OR_LENGTH');
    }
  }
  const revision = await loadReminderConversationRevision();
  if (!input.savedReplyIds && revision !== batch.conversationRevision) return;
  if (input.savedReplyIds) {
    const original = JSON.parse(batch.conversationRevision) as Array<[string, string, number, string]>;
    for (const [id, role, createdAt, content] of original) {
      const stored = await loadChatSessionMessage(PRIMARY_CHAT_SESSION_ID, id);
      if (!stored || stored.role !== role || stored.createdAt !== createdAt || stored.content !== content) return;
    }
    const allowed = new Set([...original.map(row => row[0]), ...input.savedReplyIds]);
    if ((JSON.parse(revision) as Array<[string]>).some(row => !allowed.has(row[0]))) return;
  }
  await runBackupRestoreDataEpochCommit(input.dataEpoch, async () => {
    for (let index = 0; index < batch.records.length; index++) {
      if (!await input.isCurrent()) return;
      const expected = batch.records[index]; const text = selected.get(index + 1);
      await updateChatReminderOccurrence({ occurrenceId: expected.id, expectedRevision: expected.chatReminder.revision,
        predicate: current => current.status === 'pending' && current.triggerAt > Date.now()
          && current.chatReminder.attemptId === expected.chatReminder.attemptId && !current.chatReminder.chatDelivery,
        update: current => ({ ...current, message: text || '', chatReminder: { ...current.chatReminder,
          preparedBody: { state: text === undefined ? 'failed' : text === '' ? 'quiet' : 'ready',
            conversationRevision: revision, generatedAt: Date.now(), ...(text ? { body: text, source: 'model' } : {}),
            ...(text === undefined ? { error: errors.get(index + 1) ?? (parseError || (answer === null ? 'REMINDER_LIST_NULL'
              : answer === undefined ? 'REMINDER_LIST_MISSING' : !Array.isArray(answer) ? 'REMINDER_LIST_INVALID_TYPE' : 'REMINDER_BODY_MISSING')) } : {}) } } }) });
    }
  });
}

let independent: Promise<void> | undefined;
export function isIndependentReminderPreparationActive() { return !!independent; }
/** One durable claim for the entire currently eligible batch, including rows beyond five. */
export function prepareStandaloneRemindersIndependently() {
  if (independent) return independent;
  independent = runIndependent().finally(() => { independent = undefined; });
  return independent;
}
async function runIndependent() {
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null || hasActiveChatReplyBackground() || !await canUseChatReminder()
    || !(await loadAutomaticRemoteAiPolicy({ strict: true })).enabled) return;
  const conversation = await loadPrimaryChatSession({ messageLimit: 50 });
  if (!conversation) return;
  const revision = reminderConversationRevision(conversation.messages);
  const config = await loadAiConfigPreferencesSnapshot({ maxAgeMs: 0 });
  if (!config.chatKey.trim() || !config.chatConnection || !config.profile) return;
  const now = Date.now(), batchId = `reminder-prepare:${now}:${Math.random().toString(36).slice(2)}`;
  const claimed = await runBackupRestoreDataEpochCommit(epoch, () => mutateAlarmRecords(records => {
    const eligible = records.filter((record): record is ChatReminderOccurrenceRecord => record.chatReminder?.kind === 'occurrence'
      && record.status === 'pending' && record.triggerAt > now && record.triggerAt <= now + CHAT_REMINDER_PREPARE_MS
      && !record.chatReminder.prepareClaim && !record.chatReminder.chatDelivery
      && !record.chatReminder.preparedBody);
    const ids = new Set(eligible.map(record => record.id));
    const next = records.map(record => ids.has(record.id) && record.chatReminder?.kind === 'occurrence'
      ? { ...record, updatedAt: Math.max(now, record.updatedAt + 1), chatReminder: { ...record.chatReminder,
        revision: record.chatReminder.revision + 1, prepareClaim: { batchId, owner: 'phone', claimedAt: now, conversationRevision: revision } } } : record);
    return { records: next, value: next.filter((record): record is ChatReminderOccurrenceRecord =>
      record.chatReminder?.kind === 'occurrence' && record.chatReminder.prepareClaim?.batchId === batchId)
      .sort((a, b) => a.triggerAt - b.triggerAt || a.id.localeCompare(b.id)).slice(0, 5) };
  }));
  if (!claimed.committed || !claimed.value.length) return;
  const batch = makeBatch(claimed.value, revision);
  if (!batch.records.length) return;
  const current = async () => canCommitBackupRestoreDataEpoch(epoch)
    && !hasActiveChatReplyBackground()
    && await canUseChatReminder() && (await loadAutomaticRemoteAiPolicy({ strict: true })).enabled && await standaloneReminderBatchCurrent(batch);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, Math.min(60_000, batch.records[0].triggerAt - Date.now())));
  let raw = '';
  try {
    const prompt = await buildCompiledSystemPrompt({ contextProfile: 'schedule-reminder', profile: config.profile,
      readOnly: true, memoryContext: '', moduleInstruction: REMINDER_BODY_INSTRUCTION });
    const desirePaper = await loadJunluoDesirePromptPaper(Date.now(), true);
    const recent = reminderNormalConversation(conversation.messages).map(message => ({ role: message.role,
      time: new Date(message.createdAt).toISOString(), text: message.content }));
    const messages = () => [ { role: 'system' as const, content: prompt },
      ...(desirePaper ? [{ role: 'system' as const, content: desirePaper }] : []),
      { role: 'system' as const, content: `${batch.packet}\n\n${JSON.stringify({ recent })}` } ];
    const fits = () => estimateApiMessagesTokens(messages()) + getReplyTokenReserve(config.chatConnection!) + 512
      <= (config.chatConnection!.contextWindowTokens ?? 65536);
    while (recent.length && !fits()) recent.shift();
    if (!fits()) return;
    const result = await runBudgetedAiCall('proactive', 'background', async admission => {
      await admission.beforeTransport(undefined, async () => { if (controller.signal.aborted || !await current()) throw new Error('REMINDER_PREPARATION_EXPIRED'); });
      const body = JSON.stringify({ model: config.chatConnection!.model.trim(), messages: messages() });
      const cacheMetric = beginPromptCacheMetric({ contextProfile: 'schedule-reminder',
        contextSource: 'reminder.preparation', connection: config.chatConnection! });
      try {
        const response = await fetch(`${config.chatConnection!.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST', headers: { Authorization: `Bearer ${config.chatKey.trim()}`, 'Content-Type': 'application/json' }, signal: controller.signal,
          body,
        });
        if (!response.ok) throw new Error(`REMINDER_PREPARATION_HTTP_${response.status}`);
        const payload = await response.json();
        cacheMetric.recordUsage(payload?.usage);
        const text = payload.choices?.[0]?.message?.content;
        return typeof text === 'string' ? text : '';
      } finally { cacheMetric.finish(); }
    }, { connection: config.chatConnection, dataEpoch: epoch, purpose: 'other' });
    if (result.ok && 'value' in result) raw = result.value;
  } catch { /* Claim remains consumed; failure uses the reviewed fallback. */ }
  finally { clearTimeout(timeout); controller.abort(); }
  await commitStandaloneReminderAnswer(raw, batch, { dataEpoch: epoch, isCurrent: current });
}
