import { lettersLifeStorageBridge as AsyncStorage } from '../sync/syncLettersLifeStorageBridge';
import type { LetterOpenWhen } from './letterGenerationContract';

export type LetterKind = 'exchange' | 'future-self';
export type LetterDirection = 'you-to-ai' | 'ai-to-you' | 'ai-to-future-you';
export type LetterStatus = 'waiting_ai' | 'waiting_user' | 'sealed' | 'ready_to_open' | 'completed' | 'failed';
export type LetterSource = 'user' | 'life-project' | 'memory' | 'schedule' | 'relationship-date' | 'future-self';

export type LetterEntry = {
  id: string;
  kind: LetterKind;
  direction: LetterDirection;
  status: LetterStatus;
  title: string;
  content: string;
  replyContent?: string;
  createdAt: number;
  dueAt?: number;
  deliveredAt?: number;
  openedAt?: number;
  completedAt?: number;
  notificationId?: string;
  source?: LetterSource;
  chatMessageIds?: string[];
  memoryIds?: string[];
  failureReason?: string;
  generationKey?: string;
  sourceIds?: string[];
  openWhen?: LetterOpenWhen;
  dateTicketId?: string;
};

export type LetterSettings = {
  defaultReplyDelayHours: number;
  lastProactiveRequestAt?: number;
  lastProactiveSavedAt?: number;
  offeredDateTicketIds?: string[];
  settledSourceIds?: string[];
  recentGenerationKeys?: string[];
};

export type MailboxLock =
  | {
      letter: LetterEntry;
      reason: 'waiting_ai' | 'waiting_user';
    }
  | null;

const LETTERS_KEY = 'junluo.letters.entries';
const SETTINGS_KEY = 'junluo.letters.settings';
const DEFAULT_REPLY_DELAY_HOURS = 4;
const MIN_REPLY_DELAY_HOURS = 3;
const MAX_REPLY_DELAY_HOURS = 8;

// Serialize the whole letters-array read/modify/write, not only its final capture.
let letterMutationTail: Promise<unknown> = Promise.resolve();
function runLetterMutation<T>(work: () => Promise<T>): Promise<T> {
  const pending = letterMutationTail.then(work, work);
  letterMutationTail = pending.catch(() => undefined);
  return pending;
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function clampReplyDelayHours(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_REPLY_DELAY_HOURS;
  return Math.max(MIN_REPLY_DELAY_HOURS, Math.min(MAX_REPLY_DELAY_HOURS, Math.round(value)));
}

function cleanText(value: unknown, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function cleanOptionalText(value: unknown) {
  const text = cleanText(value);
  return text || undefined;
}

function cleanTimestamp(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function cleanStringArray(value: unknown, maximum = 512) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string' && !!item))].slice(-maximum)
    : undefined;
}

function cleanOpenWhen(value: unknown): LetterOpenWhen | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind === 'date_ticket' && typeof record.dateId === 'string' && record.dateId) {
    return { kind: 'date_ticket', dateId: record.dateId };
  }
  if (record.kind === 'after_days' && Number.isInteger(record.days) && Number(record.days) >= 1 && Number(record.days) <= 90) {
    return { kind: 'after_days', days: Number(record.days) };
  }
  return undefined;
}

function isLetterKind(value: unknown): value is LetterKind {
  return value === 'exchange' || value === 'future-self';
}

function isLetterDirection(value: unknown): value is LetterDirection {
  return value === 'you-to-ai' || value === 'ai-to-you' || value === 'ai-to-future-you';
}

function isLetterStatus(value: unknown): value is LetterStatus {
  return (
    value === 'waiting_ai' ||
    value === 'waiting_user' ||
    value === 'sealed' ||
    value === 'ready_to_open' ||
    value === 'completed' ||
    value === 'failed'
  );
}

function normalizeLetter(value: unknown): LetterEntry | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<LetterEntry>;
  if (
    typeof candidate.id !== 'string' ||
    !isLetterKind(candidate.kind) ||
    !isLetterDirection(candidate.direction) ||
    !isLetterStatus(candidate.status) ||
    typeof candidate.createdAt !== 'number'
  ) {
    return null;
  }

  return {
    id: candidate.id,
    kind: candidate.kind,
    direction: candidate.direction,
    status: candidate.status,
    title: cleanText(candidate.title, candidate.kind === 'future-self' ? '写给未来的我' : '一封信'),
    content: cleanText(candidate.content),
    replyContent: cleanOptionalText(candidate.replyContent),
    createdAt: candidate.createdAt,
    dueAt: cleanTimestamp(candidate.dueAt),
    deliveredAt: cleanTimestamp(candidate.deliveredAt),
    openedAt: cleanTimestamp(candidate.openedAt),
    completedAt: cleanTimestamp(candidate.completedAt),
    notificationId: cleanOptionalText(candidate.notificationId),
    source: candidate.source,
    chatMessageIds: Array.isArray(candidate.chatMessageIds)
      ? candidate.chatMessageIds.filter((id): id is string => typeof id === 'string')
      : undefined,
    memoryIds: Array.isArray(candidate.memoryIds)
      ? candidate.memoryIds.filter((id): id is string => typeof id === 'string')
      : undefined,
    failureReason: cleanOptionalText(candidate.failureReason),
    generationKey: cleanOptionalText(candidate.generationKey),
    sourceIds: cleanStringArray(candidate.sourceIds),
    openWhen: cleanOpenWhen(candidate.openWhen),
    dateTicketId: cleanOptionalText(candidate.dateTicketId),
  };
}

function sortLetters(letters: LetterEntry[]) {
  return [...letters].sort((left, right) => {
    const leftTime = left.deliveredAt ?? left.openedAt ?? left.dueAt ?? left.createdAt;
    const rightTime = right.deliveredAt ?? right.openedAt ?? right.dueAt ?? right.createdAt;
    return rightTime - leftTime;
  });
}

export async function loadLetters() {
  const raw = await AsyncStorage.getItem(LETTERS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? sortLetters(parsed.map(normalizeLetter).filter((item): item is LetterEntry => !!item)) : [];
  } catch {
    return [];
  }
}

async function writeLetters(letters: LetterEntry[]) {
  await AsyncStorage.setItem(LETTERS_KEY, JSON.stringify(sortLetters(letters)));
}

export function saveLetters(letters: LetterEntry[]) {
  return runLetterMutation(() => writeLetters(letters));
}

async function updateLetterWithinMutation(letterId: string, patch: Partial<LetterEntry>,
  canUpdate?: (current: LetterEntry) => boolean) {
  const letters = await loadLetters();
  const current = letters.find(letter => letter.id === letterId);
  if (!current || canUpdate && !canUpdate(current)) return null;
  const next = letters.map((letter) => (letter.id === letterId ? { ...letter, ...patch } : letter));
  await writeLetters(next);
  return next.find((letter) => letter.id === letterId) ?? null;
}

export function updateLetter(letterId: string, patch: Partial<LetterEntry>,
  canUpdate?: (current: LetterEntry) => boolean) {
  return runLetterMutation(() => updateLetterWithinMutation(letterId, patch, canUpdate));
}

export function deleteLetter(letterId: string) {
  return runLetterMutation(async () => {
    const letters = await loadLetters();
    const next = letters.filter((letter) => letter.id !== letterId);
    if (next.length === letters.length) return null;
    await writeLetters(next);
    return letters.find((letter) => letter.id === letterId) ?? null;
  });
}

export async function loadLetterSettings(): Promise<LetterSettings> {
  const raw = await AsyncStorage.getItem(SETTINGS_KEY);
  if (!raw) return { defaultReplyDelayHours: DEFAULT_REPLY_DELAY_HOURS };
  try {
    const parsed = JSON.parse(raw) as Partial<LetterSettings>;
    return {
      defaultReplyDelayHours: clampReplyDelayHours(Number(parsed.defaultReplyDelayHours)),
      lastProactiveRequestAt: cleanTimestamp(parsed.lastProactiveRequestAt),
      lastProactiveSavedAt: cleanTimestamp(parsed.lastProactiveSavedAt),
      offeredDateTicketIds: cleanStringArray(parsed.offeredDateTicketIds),
      settledSourceIds: cleanStringArray(parsed.settledSourceIds),
      recentGenerationKeys: cleanStringArray(parsed.recentGenerationKeys, 128),
    };
  } catch {
    return { defaultReplyDelayHours: DEFAULT_REPLY_DELAY_HOURS };
  }
}

export async function saveLetterSettings(settings: LetterSettings) {
  const previous = await loadLetterSettings();
  const merged = { ...previous, ...settings };
  await AsyncStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({
      defaultReplyDelayHours: clampReplyDelayHours(merged.defaultReplyDelayHours),
      ...(merged.lastProactiveRequestAt !== undefined ? { lastProactiveRequestAt: merged.lastProactiveRequestAt } : {}),
      ...(merged.lastProactiveSavedAt !== undefined ? { lastProactiveSavedAt: merged.lastProactiveSavedAt } : {}),
      ...(merged.offeredDateTicketIds?.length ? { offeredDateTicketIds: merged.offeredDateTicketIds } : {}),
      ...(merged.settledSourceIds?.length ? { settledSourceIds: merged.settledSourceIds } : {}),
      ...(merged.recentGenerationKeys?.length ? { recentGenerationKeys: merged.recentGenerationKeys } : {}),
    }),
  );
}

export async function markProactiveLetterRequestStarted(input: {
  generationKey: string;
  now: number;
}) {
  const settings = await loadLetterSettings();
  await saveLetterSettings({
    ...settings,
    lastProactiveRequestAt: input.now,
    recentGenerationKeys: [...new Set([...(settings.recentGenerationKeys ?? []), input.generationKey])].slice(-128),
  });
}

export async function markProactiveLetterSourcesSaved(input: {
  dateTicketId?: string;
  now: number;
  sourceIds: readonly string[];
}) {
  const settings = await loadLetterSettings();
  await saveLetterSettings({
    ...settings,
    lastProactiveSavedAt: input.now,
    offeredDateTicketIds: input.dateTicketId
      ? [...new Set([...(settings.offeredDateTicketIds ?? []), input.dateTicketId])].slice(-512)
      : settings.offeredDateTicketIds,
    settledSourceIds: [...new Set([...(settings.settledSourceIds ?? []), ...input.sourceIds])].slice(-512),
  });
}

export async function getMailboxLock(): Promise<MailboxLock> {
  const letters = await loadLetters();
  const waiting = letters.find((letter) =>
    letter.kind === 'exchange' &&
    letter.direction === 'you-to-ai' &&
    (letter.status === 'waiting_ai' || letter.status === 'failed')
  );
  if (waiting) return { letter: waiting, reason: 'waiting_ai' };
  const incoming = letters.find((letter) => letter.kind === 'exchange' && letter.status === 'waiting_user');
  if (incoming) return { letter: incoming, reason: 'waiting_user' };
  return null;
}

export async function createUserLetter({
  content,
  delayHours,
  title,
}: {
  content: string;
  delayHours: number;
  title?: string;
}) {
  const safeDelay = clampReplyDelayHours(delayHours);
  const letter = await runLetterMutation(async () => {
    const lock = await getMailboxLock();
    if (lock) throw new Error('mailbox-locked');
    const now = Date.now();
    const letter: LetterEntry = {
      id: makeId('letter'),
      kind: 'exchange',
      direction: 'you-to-ai',
      status: 'waiting_ai',
      title: title?.trim() || '写给白云小姐',
      content: content.trim(),
      createdAt: now,
      dueAt: now + safeDelay * 60 * 60 * 1000,
      source: 'user',
    };
    const letters = await loadLetters();
    await writeLetters([letter, ...letters]);
    return letter;
  });
  if (letter.content) await import('../life/junluoDesireRuntime')
    .then(runtime => runtime.noteJunluoYouMessage(letter.createdAt)).catch(() => undefined);
  await saveLetterSettings({ defaultReplyDelayHours: safeDelay }).catch(() => undefined);
  return letter;
}

export async function createAiIncomingLetter({
  content,
  generationKey,
  onCreated,
  sourceIds,
  source,
  title,
}: {
  content: string;
  generationKey?: string;
  onCreated?: (letter: LetterEntry) => void;
  sourceIds?: string[];
  source: LetterSource;
  title?: string;
}) {
  return runLetterMutation(async () => {
    const deterministicId = generationKey ? `${generationKey}:current` : null;
    if (deterministicId) {
      const existing = (await loadLetters()).find((letter) => letter.id === deterministicId);
      if (existing) return existing;
    }
    const lock = await getMailboxLock();
    if (lock) return null;
    const now = Date.now();
    const letter: LetterEntry = {
      id: deterministicId ?? makeId('letter'),
      kind: 'exchange',
      direction: 'ai-to-you',
      status: 'waiting_user',
      title: title?.trim() || '白云小姐寄来的信',
      content: content.trim(),
      createdAt: now,
      deliveredAt: now,
      source,
      generationKey,
      sourceIds,
    };
    const letters = await loadLetters();
    await writeLetters([letter, ...letters]);
    try { onCreated?.(letter); } catch { /* A completed save is not undone by observation. */ }
    return letter;
  });
}

export async function createFutureLetter({
  content,
  dateTicketId,
  dueAt,
  generationKey,
  onCreated,
  openWhen,
  source = 'future-self',
  sourceIds,
  title,
}: {
  content: string;
  dateTicketId?: string;
  dueAt: number;
  generationKey?: string;
  onCreated?: (letter: LetterEntry) => void;
  openWhen?: LetterOpenWhen;
  source?: LetterSource;
  sourceIds?: string[];
  title?: string;
}) {
  return runLetterMutation(async () => {
    const now = Date.now();
    const deterministicId = generationKey ? `${generationKey}:future` : null;
    if (deterministicId) {
      const existing = (await loadLetters()).find((letter) => letter.id === deterministicId);
      if (existing) return existing;
    }
    const letter: LetterEntry = {
      id: deterministicId ?? makeId('future-letter'),
      kind: 'future-self',
      direction: 'ai-to-future-you',
      status: dueAt <= now ? 'ready_to_open' : 'sealed',
      title: title?.trim() || '写给未来的我',
      content: content.trim(),
      createdAt: now,
      dueAt,
      source,
      generationKey,
      sourceIds,
      openWhen,
      dateTicketId,
    };
    const letters = await loadLetters();
    await writeLetters([letter, ...letters]);
    try { onCreated?.(letter); } catch { /* A completed save is not undone by observation. */ }
    return letter;
  });
}

export async function replyToAiLetter(letterId: string, replyContent: string) {
  const now = Date.now();
  let hadReply = false;
  const saved = await runLetterMutation(async () => {
    const previous = (await loadLetters()).find(letter => letter.id === letterId);
    hadReply = !!previous?.replyContent?.trim();
    return updateLetterWithinMutation(letterId, {
      completedAt: previous?.replyContent?.trim() ? previous.completedAt : now,
      replyContent: replyContent.trim(),
      status: 'completed',
    });
  });
  if (saved?.direction === 'ai-to-you' && saved.replyContent?.trim() && !hadReply) {
    await import('../life/junluoDesireRuntime')
      .then(runtime => runtime.noteJunluoYouMessage(now)).catch(() => undefined);
  }
  return saved;
}

export async function openFutureLetter(letterId: string) {
  return runLetterMutation(async () => {
    const now = Date.now();
    const letters = await loadLetters();
    const letter = letters.find((item) => item.id === letterId);
    if (!letter || letter.kind !== 'future-self' || (letter.dueAt ?? 0) > now) return null;
    return updateLetterWithinMutation(letterId, {
      openedAt: letter.openedAt ?? now,
      status: 'completed',
    });
  });
}

export async function markDueFutureLettersReady(now = Date.now()) {
  return runLetterMutation(async () => {
    const letters = await loadLetters();
    let changed = false;
    const next = letters.map((letter) => {
      if (letter.kind === 'future-self' && letter.status === 'sealed' && (letter.dueAt ?? Infinity) <= now) {
        changed = true;
        return { ...letter, status: 'ready_to_open' as const };
      }
      return letter;
    });
    if (changed) await writeLetters(next);
    return next.filter((letter) => letter.kind === 'future-self' && letter.status === 'ready_to_open');
  });
}
