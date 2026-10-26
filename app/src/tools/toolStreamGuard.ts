export type JunLuoToolStreamEventType = 'SAVEPOINT' | 'ROLLBACK';

export type JunLuoToolStreamEvent = {
  type: JunLuoToolStreamEventType;
  id: string;
  reason?: string;
  createdAt: number;
};

export type JunLuoToolStreamRevisionTracker = {
  text: string;
  savepoints: Record<string, string>;
};

export function createToolStreamSavepoint(id: string): JunLuoToolStreamEvent {
  return {
    type: 'SAVEPOINT',
    id,
    createdAt: Date.now(),
  };
}

export function createToolStreamRollback(id: string, reason?: string): JunLuoToolStreamEvent {
  return {
    type: 'ROLLBACK',
    id,
    reason,
    createdAt: Date.now(),
  };
}

export function createToolStreamRevisionTracker(initialText = ''): JunLuoToolStreamRevisionTracker {
  return {
    text: initialText,
    savepoints: {},
  };
}

export function appendToolStreamChunk(
  tracker: JunLuoToolStreamRevisionTracker,
  chunk: string,
): JunLuoToolStreamRevisionTracker {
  return {
    ...tracker,
    text: `${tracker.text}${chunk}`,
  };
}

export function saveToolStreamPoint(
  tracker: JunLuoToolStreamRevisionTracker,
  id: string,
): JunLuoToolStreamRevisionTracker {
  return {
    ...tracker,
    savepoints: {
      ...tracker.savepoints,
      [id]: tracker.text,
    },
  };
}

export function rollbackToolStreamPoint(
  tracker: JunLuoToolStreamRevisionTracker,
  id: string,
): JunLuoToolStreamRevisionTracker {
  const snapshot = tracker.savepoints[id];
  if (snapshot == null) return tracker;
  return {
    ...tracker,
    text: snapshot,
  };
}

export function getToolStreamText(tracker: JunLuoToolStreamRevisionTracker) {
  return tracker.text;
}
