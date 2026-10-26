export const RETIRED_BAIYUN_BOOKSHELF_STORAGE_KEY =
  'junluo.baiyun.bookshelf' as const;
export const RETIRED_LIFE_PROJECT_CURRENT_KEY =
  'junluo.assistant.lifeProject.current' as const;
export const RETIRED_LIFE_PROJECT_HISTORY_KEY =
  'junluo.assistant.lifeProject.history' as const;
export const RETIRED_PERSONA_CRITIC_RESULT_KEY =
  'junluo.lastCriticResult' as const;
export const RETIRED_PERSONA_CRITIC_ATTEMPT_KEY =
  'junluo.lastCriticAttemptAt' as const;
export const RETIRED_SOCIAL_SHARE_QUEUE_KEY =
  'junluo.life.socialAgent.shareQueue.v1' as const;
export const RETIRED_ASSISTANT_FEATURE_V1_MIGRATION_KEY =
  'junluo.localMigration.retiredAssistantFeatures.v1' as const;
export const RETIRED_ASSISTANT_FEATURE_MIGRATION_KEY =
  'junluo.localMigration.retiredAssistantFeatures.v2' as const;

export const RETIRED_ASSISTANT_FEATURE_STORAGE_KEYS = Object.freeze([
  'junluo.baiyunBehavior.currentAction',
  RETIRED_BAIYUN_BOOKSHELF_STORAGE_KEY,
  RETIRED_LIFE_PROJECT_CURRENT_KEY,
  RETIRED_LIFE_PROJECT_HISTORY_KEY,
  RETIRED_PERSONA_CRITIC_RESULT_KEY,
  RETIRED_PERSONA_CRITIC_ATTEMPT_KEY,
  RETIRED_SOCIAL_SHARE_QUEUE_KEY,
  RETIRED_ASSISTANT_FEATURE_V1_MIGRATION_KEY,
] as const);

export const RETIRED_ASSISTANT_FEATURE_BACKUP_EXCLUDED_KEYS = Object.freeze([
  ...RETIRED_ASSISTANT_FEATURE_STORAGE_KEYS,
  RETIRED_ASSISTANT_FEATURE_MIGRATION_KEY,
] as const);

export const ASSISTANT_LIFE_DAY_STORAGE_PREFIX =
  'junluo.assistant.lifeDay.' as const;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: UnknownRecord, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function stripRetiredActionMetadata<T>(value: T): T {
  if (!isRecord(value) || (!hasOwn(value, 'actionPlanId') && !hasOwn(value, 'actionSourceKey'))) return value;
  const { actionPlanId: _plan, actionSourceKey: _source, ...message } = value;
  return message as T;
}

function sanitizeRetiredChatStorage(key: string, serialized: string) {
  if (key === 'junluo.period.reminderSettings.v1') {
    try {
      const parsed: unknown = JSON.parse(serialized);
      if (!isRecord(parsed)) return serialized;
      const { predictionEnabled: _prediction, suppliesEnabled: _supplies, ...settings } = parsed;
      return JSON.stringify(settings);
    } catch { return serialized; }
  }
  const messageArray = key === 'junluo.chat.primaryMessages' || key.startsWith('junluo.chat.sessionMessages.')
    || key === 'junluo.tools.auditLog.v1';
  const messageRecord = key.startsWith('junluo.chat.sessionMessage.');
  const sessions = key === 'junluo.chat.sessions';
  if (!messageArray && !messageRecord && !sessions) return serialized;
  try {
    const parsed: unknown = JSON.parse(serialized);
    let changed = false;
    const strip = (value: unknown) => {
      const next = stripRetiredActionMetadata(value);
      if (next !== value) changed = true;
      return next;
    };
    const next = messageRecord ? strip(parsed)
      : Array.isArray(parsed) ? parsed.map((value) => {
          if (!sessions) return strip(value);
          if (!isRecord(value) || !Array.isArray(value.messages)) return value;
          return { ...value, messages: value.messages.map(strip) };
        }) : parsed;
    return changed ? JSON.stringify(next) : serialized;
  } catch {
    return serialized;
  }
}

export function isAssistantLifeDayStorageKey(key: string) {
  return key.startsWith(ASSISTANT_LIFE_DAY_STORAGE_PREFIX);
}

export function stripRetiredLifeProjectFields<T>(value: T): {
  changed: boolean;
  value: T;
} {
  if (!isRecord(value)) return { changed: false, value };
  let changed = false;
  const next: UnknownRecord = { ...value };

  for (const key of ['lifeProjectSnapshot', 'lifeProjectBlock']) {
    if (!hasOwn(next, key)) continue;
    delete next[key];
    changed = true;
  }

  const removedDeviationIds = new Set<string>();
  if (Array.isArray(next.deviations)) {
    const deviations = next.deviations.filter((deviation) => {
      if (!isRecord(deviation) || deviation.reasonSource !== 'project') return true;
      if (typeof deviation.id === 'string') removedDeviationIds.add(deviation.id);
      changed = true;
      return false;
    });
    if (deviations.length !== next.deviations.length) next.deviations = deviations;
  }

  const projectSegmentIds = new Set<string>();
  if (Array.isArray(next.segments)) {
    next.segments = next.segments.map((segment) => {
      if (!isRecord(segment)) return segment;
      let segmentChanged = false;
      const clean = { ...segment };
      if (hasOwn(clean, 'generatedLifeProjectKey')) {
        if (typeof clean.id === 'string') projectSegmentIds.add(clean.id);
        delete clean.generatedLifeProjectKey;
        delete clean.generatedDraft;
        segmentChanged = true;
      }
      if (
        typeof clean.deviationId === 'string'
        && removedDeviationIds.has(clean.deviationId)
      ) {
        delete clean.deviationId;
        segmentChanged = true;
      }
      if (segmentChanged) changed = true;
      return segmentChanged ? clean : segment;
    });
  }

  if (projectSegmentIds.size && Array.isArray(next.timelineEntries)) {
    const timelineEntries = next.timelineEntries.filter((entry) => (
      !isRecord(entry)
      || typeof entry.segmentId !== 'string'
      || !projectSegmentIds.has(entry.segmentId)
    ));
    if (timelineEntries.length !== next.timelineEntries.length) {
      next.timelineEntries = timelineEntries;
      changed = true;
    }
  }

  return { changed, value: (changed ? next : value) as T };
}

export type RetiredAssistantStorageSanitizeReport = {
  removedRetiredKeyCount: number;
  sanitizedLifeDayCount: number;
  droppedLifeDayCount: number;
};

export function sanitizeRetiredAssistantStorage(
  storage: Readonly<Record<string, string>>,
): {
  storage: Record<string, string>;
  report: RetiredAssistantStorageSanitizeReport;
} {
  const retiredKeys = new Set<string>(
    RETIRED_ASSISTANT_FEATURE_BACKUP_EXCLUDED_KEYS,
  );
  const sanitized: Record<string, string> = {};
  let removedRetiredKeyCount = 0;
  let sanitizedLifeDayCount = 0;
  let droppedLifeDayCount = 0;

  for (const [key, serialized] of Object.entries(storage)) {
    if (retiredKeys.has(key)) {
      removedRetiredKeyCount += 1;
      continue;
    }
    if (key === 'junluo.assistant.currentState') {
      try {
        const parsed = JSON.parse(serialized) as unknown;
        if (isRecord(parsed) && hasOwn(parsed, 'sleepSource')) {
          const { sleepSource: _retiredSoothingSource, ...current } = parsed;
          sanitized[key] = JSON.stringify(current);
          continue;
        }
      } catch { /* Preserve existing invalid-data handling at the restore boundary. */ }
    }
    if (!isAssistantLifeDayStorageKey(key)) {
      sanitized[key] = sanitizeRetiredChatStorage(key, serialized);
      continue;
    }
    try {
      const parsed = JSON.parse(serialized) as unknown;
      if (!isRecord(parsed)) {
        droppedLifeDayCount += 1;
        continue;
      }
      const stripped = stripRetiredLifeProjectFields(parsed);
      sanitized[key] = stripped.changed
        ? JSON.stringify(stripped.value)
        : serialized;
      if (stripped.changed) sanitizedLifeDayCount += 1;
    } catch {
      droppedLifeDayCount += 1;
    }
  }

  return {
    storage: sanitized,
    report: {
      removedRetiredKeyCount,
      sanitizedLifeDayCount,
      droppedLifeDayCount,
    },
  };
}
