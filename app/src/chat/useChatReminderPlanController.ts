import type { MusicSong } from '../ai/subjectiveMessages';
import { editReminderPlan, reminderDraftError, type ChatReminderPlanCard, type ReminderDraft,
  type ReminderPlanResult, type ReminderPlanRow, type ReminderPlanSource } from './chatReminderPlan';

export type ReminderPlanMutationResult = Pick<ReminderPlanRow, 'result' | 'code'> & {
  state: 'saved' | 'failed' | 'conflict' | 'unknown';
};
export type ChatReminderPlanControllerPorts = {
  readCard(messageId: string): Promise<ChatReminderPlanCard | null>;
  patchCard(messageId: string, revision: number, next: ChatReminderPlanCard): Promise<ChatReminderPlanCard | null>;
  claimFeedback(messageId: string): Promise<ChatReminderPlanCard | null>;
  canSave(row?: ReminderPlanRow): boolean | Promise<boolean>;
  isSourceCurrent(source: ReminderPlanSource): boolean | Promise<boolean>;
  resolveSong(row: ReminderPlanRow, isCurrent: () => Promise<boolean>): Promise<MusicSong>;
  applyMutation(row: ReminderPlanRow, guard: { messageId: string; revision: number; source: ReminderPlanSource },
    reconcileOnly: boolean): Promise<ReminderPlanMutationResult>;
  onFeedback(messageId: string, rows: ReminderPlanResult[], source: ReminderPlanSource): Promise<void>;
};
export type ChatReminderPlanSaveOutcome = { rows: ReminderPlanResult[]; feedback: 'not-needed' | 'sent' | 'failed';
  blocked?: 'missing' | 'restored' | 'permission' | 'source' | 'budget' | 'storage' };
const activeSaves = new Map<string, Promise<ChatReminderPlanSaveOutcome>>();
const pendingEdits = new Map<string, Promise<ChatReminderPlanCard | null>>();

/** Explicit Save only. Ordinary restart never starts resolution or mutation. */
export function createChatReminderPlanController(ports: ChatReminderPlanControllerPorts) {
  function edit(messageId: string, id: string, patch: Partial<ReminderDraft> | null) {
    if (activeSaves.has(messageId)) return Promise.resolve(null);
    const update = patch ? JSON.parse(JSON.stringify(patch)) as Partial<ReminderDraft> : null;
    const previous = pendingEdits.get(messageId) ?? Promise.resolve(null);
    const task = previous.catch(() => null).then(async () => {
      const card = await ports.readCard(messageId);
      const next = card ? editReminderPlan(card, id, update) : null;
      return next && card ? ports.patchCard(messageId, card.revision, next) : null;
    }).finally(() => { if (pendingEdits.get(messageId) === task) pendingEdits.delete(messageId); });
    pendingEdits.set(messageId, task); return task;
  }
  async function runSave(messageId: string): Promise<ChatReminderPlanSaveOutcome> {
    let card = await ports.readCard(messageId);
    const outcome: ChatReminderPlanSaveOutcome = { rows: [], feedback: 'not-needed' };
    if (!card) return { ...outcome, blocked: 'missing' };
    if (card.status !== 'active') return { ...outcome, blocked: 'restored' };
    if (!card.feedback.claimed && card.feedback.remainingRequests <= 0) return { ...outcome, blocked: 'budget' };
    for (const id of card.rows.map(row => row.id)) {
      card = await ports.readCard(messageId);
      if (!card || card.status !== 'active') return { ...outcome, blocked: card ? 'restored' : 'missing' };
      let row = card.rows.find(item => item.id === id);
      if (!row || row.state === 'saved') continue;
      if (!await ports.canSave(row)) return { ...outcome, blocked: 'permission' };
      if (!await ports.isSourceCurrent(card.source)) return { ...outcome, blocked: 'source' };
      const reconcileOnly = row.state === 'saving' || row.state === 'unknown';
      if (!reconcileOnly && row.draft?.mode === 'music' && !row.draft.musicSong
        && row.draft.songRequest?.title.trim() && row.draft.songRequest.artist.trim()) {
        const revision = card.revision, source = card.source, unresolved = row;
        const current = async () => !!await ports.canSave(unresolved) && !!await ports.isSourceCurrent(source)
          && (await ports.readCard(messageId))?.revision === revision;
        try {
          // Network resolution finishes before either the saving marker or short domain commit.
          const song = await ports.resolveSong(row, current);
          if (!await current()) return { ...outcome, blocked: 'source' };
          const next = { ...card, revision: card.revision + 1, rows: card.rows.map(item => item.id === id
            ? { ...item, draft: { ...item.draft!, musicSong: song }, code: undefined } : item) };
          card = await ports.patchCard(messageId, card.revision, next);
          if (!card) return { ...outcome, blocked: 'storage' };
          row = card.rows.find(item => item.id === id)!;
        } catch {
          if (!card) return { ...outcome, blocked: 'storage' };
          if (!await ports.canSave(row)) return { ...outcome, blocked: 'permission' };
          if (!await ports.isSourceCurrent(card.source)) return { ...outcome, blocked: 'source' };
          const next = { ...card, revision: card.revision + 1, rows: card.rows.map(item => item.id === id
            ? { ...item, state: 'failed' as const, code: 'MUSIC_UNRESOLVED' } : item) };
          if (!await ports.patchCard(messageId, card.revision, next)) return { ...outcome, blocked: 'storage' };
          continue;
        }
      }
      const error = row.action !== 'cancel' && row.draft ? reminderDraftError(row.draft) : undefined;
      if (error && !reconcileOnly) {
        const next = { ...card, revision: card.revision + 1, rows: card.rows.map(item => item.id === id
          ? { ...item, state: 'failed' as const, code: error } : item) };
        if (!await ports.patchCard(messageId, card.revision, next)) return { ...outcome, blocked: 'storage' };
        continue;
      }
      if (!reconcileOnly) {
        const next: ChatReminderPlanCard = { ...card, revision: card.revision + 1, rows: card.rows.map(item => item.id === id
          ? { ...item, state: 'saving', code: undefined } : item) };
        card = await ports.patchCard(messageId, card.revision, next);
        if (!card) return { ...outcome, blocked: 'storage' };
        row = card.rows.find(item => item.id === id)!;
      }
      if (!await ports.canSave(row)) return { ...outcome, blocked: 'permission' };
      if (!await ports.isSourceCurrent(card.source)) return { ...outcome, blocked: 'source' };
      const current = await ports.readCard(messageId);
      if (!current || current.status !== 'active' || current.revision !== card.revision) return { ...outcome, blocked: 'storage' };
      let result: ReminderPlanMutationResult;
      try { result = await ports.applyMutation(row, { messageId, revision: card.revision, source: card.source }, reconcileOnly); }
      catch { result = { state: 'unknown', code: 'EXECUTION_INTERRUPTED' }; }
      if (result.state === 'saved' && !result.result) result = { state: 'unknown', code: 'SAVED_RECORD_MISSING' };
      const next: ChatReminderPlanCard = { ...card, revision: card.revision + 1, rows: card.rows.map(item => item.id === id
        ? { ...item, state: result.state, result: result.result, code: result.code } : item) };
      if (!await ports.patchCard(messageId, card.revision, next)) return { ...outcome, blocked: 'storage' };
    }
    card = await ports.readCard(messageId);
    if (!card || card.status !== 'active') return { ...outcome, blocked: card ? 'restored' : 'missing' };
    outcome.rows = card.rows.filter(row => ['saved', 'failed', 'conflict', 'unknown'].includes(row.state))
      .map(({ id, action, state, result, code }) => ({ id, action, state, result, code }));
    if (!outcome.rows.length || card.rows.some(row => ['pending', 'saving'].includes(row.state)) || card.feedback.claimed) return outcome;
    if (!await ports.canSave() || !await ports.isSourceCurrent(card.source)) return outcome;
    const claimed = await ports.claimFeedback(messageId);
    if (!claimed) return outcome;
    try {
      if (!await ports.canSave() || !await ports.isSourceCurrent(claimed.source)) return outcome;
      const current = await ports.readCard(messageId);
      if (!current || current.status !== 'active' || current.revision !== claimed.revision) return outcome;
      await ports.onFeedback(messageId, outcome.rows, claimed.source); outcome.feedback = 'sent';
    } catch { outcome.feedback = 'failed'; }
    return outcome;
  }
  function save(messageId: string) {
    const active = activeSaves.get(messageId); if (active) return active;
    const task = (pendingEdits.get(messageId) ?? Promise.resolve(null)).then(() => runSave(messageId))
      .catch((): ChatReminderPlanSaveOutcome => ({ rows: [], feedback: 'not-needed', blocked: 'storage' }))
      .finally(() => { if (activeSaves.get(messageId) === task) activeSaves.delete(messageId); });
    activeSaves.set(messageId, task); return task;
  }
  return { edit, remove: (messageId: string, id: string) => edit(messageId, id, null), save };
}

export function reminderPlanDate(at: number) {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function reminderPlanClock(at: number) {
  const date = new Date(at); return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
export function reminderPlanTimestamp(date: string, clock: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(clock)) return null;
  const [year, month, day] = date.split('-').map(Number), [hour, minute] = clock.split(':').map(Number);
  const value = new Date(year, month - 1, day, hour, minute, 0, 0);
  return value.getFullYear() === year && value.getMonth() === month - 1 && value.getDate() === day
    && value.getHours() === hour && value.getMinutes() === minute ? value.getTime() : null;
}
