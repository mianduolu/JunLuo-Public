import AsyncStorage from '@react-native-async-storage/async-storage';

import { buildMissedVoiceCallMaterial } from './voiceCallInvitationPrompt';

export type VoiceCallInvitationKind = 'autonomous' | 'scheduled';
export type VoiceCallInvitationStatus =
  | 'scheduled'
  | 'ringing'
  | 'answered'
  | 'declined'
  | 'timed_out'
  | 'cancelled'
  | 'suppressed_busy'
  | 'failed';
export type VoiceCallMissedOutcome = 'timeout' | 'declined';

export type VoiceCallInvitation = {
  createdAt: number;
  invitationId: string;
  isTest?: boolean;
  kind: VoiceCallInvitationKind;
  nativeTaskId?: string;
  note?: string;
  scheduledAt: number;
  status: VoiceCallInvitationStatus;
  updatedAt: number;
};

export type VoiceCallMissedEvent = {
  calledAt: number;
  invitationId: string;
  kind: VoiceCallInvitationKind;
  note?: string;
  outcome: VoiceCallMissedOutcome;
  scheduledAt?: number;
};

type InvitationLedger = {
  invitations: VoiceCallInvitation[];
  missed: VoiceCallMissedEvent[];
  version: 1;
};

const STORAGE_KEY = 'junluo.voiceCall.invitations.v1';
const MISSED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_INVITATIONS = 80;

const emptyLedger = (): InvitationLedger => ({ invitations: [], missed: [], version: 1 });

function normalizeLedger(value: unknown): InvitationLedger {
  if (!value || typeof value !== 'object') return emptyLedger();
  const candidate = value as Partial<InvitationLedger>;
  return {
    invitations: Array.isArray(candidate.invitations)
      ? candidate.invitations.filter((item): item is VoiceCallInvitation => (
          !!item && typeof item === 'object' && typeof item.invitationId === 'string'
          && typeof item.scheduledAt === 'number' && (item.kind === 'autonomous' || item.kind === 'scheduled')
        )).slice(-MAX_INVITATIONS)
      : [],
    missed: Array.isArray(candidate.missed)
      ? candidate.missed.filter((item): item is VoiceCallMissedEvent => (
          !!item && typeof item === 'object' && typeof item.invitationId === 'string'
          && typeof item.calledAt === 'number' && (item.outcome === 'declined' || item.outcome === 'timeout')
        ))
      : [],
    version: 1,
  };
}

async function loadLedger() {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? normalizeLedger(JSON.parse(raw) as unknown) : emptyLedger();
  } catch {
    return emptyLedger();
  }
}

async function saveLedger(ledger: InvitationLedger) {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({
    ...ledger,
    invitations: ledger.invitations.slice(-MAX_INVITATIONS),
  }));
}

let ledgerQueue = Promise.resolve();
function enqueue<T>(task: () => Promise<T>) {
  const run = ledgerQueue.then(task, task);
  ledgerQueue = run.then(() => undefined, () => undefined);
  return run;
}

export function createVoiceCallInvitation(input: {
  invitationId?: string;
  isTest?: boolean;
  kind: VoiceCallInvitationKind;
  nativeTaskId?: string;
  note?: string;
  now?: number;
  scheduledAt: number;
}) {
  return enqueue(async () => {
    const now = input.now ?? Date.now();
    const invitationId = input.invitationId ?? `voice-call-${input.kind}-${input.scheduledAt}-${Math.random().toString(36).slice(2, 8)}`;
    const invitation: VoiceCallInvitation = {
      createdAt: now,
      invitationId,
      isTest: input.isTest === true,
      kind: input.kind,
      nativeTaskId: input.nativeTaskId,
      note: input.note?.trim() || undefined,
      scheduledAt: input.scheduledAt,
      status: 'scheduled',
      updatedAt: now,
    };
    const ledger = await loadLedger();
    const invitations = ledger.invitations.filter((item) => item.invitationId !== invitationId);
    await saveLedger({ ...ledger, invitations: [...invitations, invitation] });
    return invitation;
  });
}

export function updateVoiceCallInvitationStatus(
  invitationId: string,
  status: VoiceCallInvitationStatus,
  now = Date.now(),
) {
  return enqueue(async () => {
    const ledger = await loadLedger();
    const current = ledger.invitations.find((item) => item.invitationId === invitationId);
    if (!current) return null;
    const updated = { ...current, status, updatedAt: now };
    const invitations = ledger.invitations.map((item) => item.invitationId === invitationId ? updated : item);
    let missed = ledger.missed;
    if (!current.isTest && current.status !== status && (status === 'declined' || status === 'timed_out')) {
      const event: VoiceCallMissedEvent = {
        calledAt: current.scheduledAt,
        invitationId,
        kind: current.kind,
        note: current.note,
        outcome: status === 'declined' ? 'declined' : 'timeout',
        scheduledAt: current.scheduledAt,
      };
      missed = [...missed.filter((item) => item.invitationId !== invitationId), event];
    }
    await saveLedger({ ...ledger, invitations, missed });
    return updated;
  });
}

export function updateVoiceCallInvitationNativeTaskId(invitationId: string, nativeTaskId: string) {
  return enqueue(async () => {
    const ledger = await loadLedger();
    const current = ledger.invitations.find((item) => item.invitationId === invitationId);
    if (!current) return null;
    const updated = { ...current, nativeTaskId };
    const invitations = ledger.invitations.map((item) => item.invitationId === invitationId ? updated : item);
    await saveLedger({ ...ledger, invitations });
    return updated;
  });
}

export async function loadVoiceCallInvitations() {
  return (await loadLedger()).invitations;
}

export async function loadRecentMissedVoiceCalls(now = Date.now()) {
  const cutoff = now - MISSED_RETENTION_MS;
  return (await loadLedger()).missed
    .filter((item) => item.calledAt >= cutoff && item.calledAt <= now)
    .sort((a, b) => b.calledAt - a.calledAt)
    .slice(0, 3);
}

export function clearRecentMissedVoiceCalls() {
  return enqueue(async () => {
    const ledger = await loadLedger();
    await saveLedger({ ...ledger, missed: [] });
  });
}

export async function buildRecentMissedVoiceCallContext(now = Date.now()) {
  const events = await loadRecentMissedVoiceCalls(now);
  return [...events]
    .reverse()
    .map((item) => buildMissedVoiceCallMaterial(item))
    .join('\n\n');
}

export async function countAutonomousCallsToday(now = Date.now()) {
  const date = new Date(now);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const invitations = await loadVoiceCallInvitations();
  return invitations.filter((item) => (
    item.kind === 'autonomous' && !item.isTest && item.scheduledAt >= start && item.scheduledAt <= now
    && !['cancelled', 'failed', 'suppressed_busy'].includes(item.status)
  )).length;
}

export async function latestAutonomousVoiceCallAt() {
  const invitations = await loadVoiceCallInvitations();
  return invitations
    .filter((item) => (
      item.kind === 'autonomous' && !item.isTest
      && !['cancelled', 'failed', 'suppressed_busy'].includes(item.status)
    ))
    .reduce((latest, item) => Math.max(latest, item.scheduledAt), 0);
}
