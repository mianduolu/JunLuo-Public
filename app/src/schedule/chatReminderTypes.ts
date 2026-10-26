export type ChatReminderMode = 'notification' | 'music';
export type ChatReminderScope = 'once' | 'future';
export type ChatReminderRepeat =
  | { kind: 'once' }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; hour: number; minute: number; weekdays: number[] };

type ChatReminderBase = {
  version: 1;
  kind: 'series' | 'occurrence';
  revision: number;
  mode: ChatReminderMode;
  lastOperationId: string;
  note?: string;
};

export type ChatReminderSeries = ChatReminderBase & {
  kind: 'series';
  repeat: ChatReminderRepeat;
  sourceMessageId?: string;
  nextOccurrenceId?: string;
};

export type ChatReminderPreparedBody = {
  state: 'ready' | 'quiet' | 'failed';
  conversationRevision: string;
  generatedAt: number;
  body?: string;
  source?: 'model' | 'reviewed_fallback';
  error?: string;
};

export type ChatReminderOccurrence = ChatReminderBase & {
  kind: 'occurrence';
  seriesId: string;
  seriesRevision: number;
  scheduledAt: number;
  attemptId: string;
  snoozeCount: number;
  terminalReason?: 'missed' | 'permission-denied' | 'outcome-unknown';
  musicControl?: { operationId: string; action: 'stop' | 'snooze'; at: number; minutes?: number };
  prepareClaim?: {
    batchId: string;
    owner: string;
    claimedAt: number;
    conversationRevision: string;
  };
  preparedBody?: ChatReminderPreparedBody;
  chatDelivery?: {
    messageId: string;
    body: string;
    deliveredAt: number;
    attemptId: string;
    state?: 'pending' | 'saved' | 'failed' | 'unknown';
    error?: string;
  };
  notificationEvidence?: {
    attemptId: string;
    state: 'pending' | 'scheduled' | 'shown' | 'failed';
    updatedAt: number;
    notificationId?: string;
    error?: string;
  };
  musicEvidence?: {
    attemptId: string;
    state: 'pending' | 'claimed' | 'played' | 'failed' | 'skipped';
    attempts: number;
    owner?: string;
    attemptedAt?: number;
    finishedAt?: number;
    error?: string;
  };
};

export type ChatReminderMetadata = ChatReminderSeries | ChatReminderOccurrence;
