import {
  assistantLifeStateStorageBridge as AsyncStorage,
} from '../sync/syncAssistantLifeStateStorageBridge';
import {
  captureBackupRestoreDataEpoch,
  canCommitBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import {
  JUNLUO_INNER_STATE_KEYS,
  type JunluoAffectStateV1,
  type JunluoDesireState,
  type JunluoThoughtStateV2,
  isJunluoAffectStateV1,
  isJunluoDesireState,
  isJunluoThoughtStateV2,
} from './junluoInnerState';
import {
  createDefaultJunluoAffectState,
  createDefaultJunluoDesireState,
  createDefaultJunluoThoughtState,
  upgradeJunluoAffectState,
  upgradeJunluoDesireState,
  upgradeJunluoThoughtState,
} from './junluoInnerStatePersistence';

type StateValidator<T> = (value: unknown) => value is T;

async function saveState<T>(
  key: string,
  value: T,
  validate: StateValidator<T>,
) {
  if (!validate(value)) throw new Error(`${key} 不符合严格合同。`);
  await AsyncStorage.setItem(key, JSON.stringify(value));
}

let desireWriteTail: Promise<unknown> = Promise.resolve();
let affectWriteTail: Promise<unknown> = Promise.resolve();
let thoughtWriteTail: Promise<unknown> = Promise.resolve();

type InnerWriteOptions = {
  dataEpoch?: number | null;
  shouldCommit?: () => boolean | Promise<boolean>;
};

export function runJunluoDesireWriteBoundary<T>(work: () => Promise<T>): Promise<T> {
  const result = desireWriteTail.then(work, work);
  desireWriteTail = result.catch(() => undefined);
  return result;
}

function runJunluoAffectWriteBoundary<T>(work: () => Promise<T>): Promise<T> {
  const result = affectWriteTail.then(work, work);
  affectWriteTail = result.catch(() => undefined);
  return result;
}

async function readDesireState() {
  const raw = await AsyncStorage.getItem(JUNLUO_INNER_STATE_KEYS.desire);
  if (raw === null) return { state: createDefaultJunluoDesireState(), migrated: false };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    throw new Error('已保存十维状态不是有效 JSON，未改写原数据。');
  }
  const upgraded = upgradeJunluoDesireState(parsed);
  if (!upgraded) throw new Error('已保存十维状态无法升级，未改写原数据。');
  return {
    state: upgraded,
    migrated: !isJunluoDesireState(parsed),
  };
}

export function loadJunluoDesireState(readOnly = false): Promise<JunluoDesireState> {
  if (readOnly) return readDesireState().then(value => value.state);
  const epoch = captureBackupRestoreDataEpoch();
  return runJunluoDesireWriteBoundary(async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const { state, migrated } = await readDesireState();
        if (migrated) {
          const result = await runBackupRestoreDataEpochCommit(epoch, () => saveState(
            JUNLUO_INNER_STATE_KEYS.desire, state, isJunluoDesireState,
          ));
          if (!result.committed) throw new Error('inner-data-epoch-changed');
        }
        return state;
      } catch (error) {
        if (attempt === 1 || !canCommitBackupRestoreDataEpoch(epoch)) throw error;
      }
    }
  });
}

export function updateJunluoDesireState(
  update: (latest: JunluoDesireState) => JunluoDesireState,
  options: {
    dataEpoch?: number | null;
    shouldCommit?: () => boolean | Promise<boolean>;
  } = {},
): Promise<JunluoDesireState | null> {
  const epoch = options.dataEpoch === undefined
    ? captureBackupRestoreDataEpoch() : options.dataEpoch;
  return runJunluoDesireWriteBoundary(async () => {
    const result = await runBackupRestoreDataEpochCommit(epoch, async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          if (!canCommitBackupRestoreDataEpoch(epoch)) return null;
          if (options.shouldCommit && !await options.shouldCommit()) return null;
          const { state, migrated } = await readDesireState();
          const next = update(state);
          if (options.shouldCommit && !await options.shouldCommit()) return null;
          if (!canCommitBackupRestoreDataEpoch(epoch)) return null;
          if (migrated || next !== state) {
            await saveState(JUNLUO_INNER_STATE_KEYS.desire, next, isJunluoDesireState);
          }
          return next;
        } catch (error) {
          if (attempt === 3) throw error;
        }
      }
    });
    return result.committed ? result.value : null;
  });
}

export async function saveJunluoDesireState(value: JunluoDesireState) {
  const saved = await updateJunluoDesireState(() => value);
  if (!saved) throw new Error('inner-data-epoch-changed');
}

export function loadJunluoAffectState(readOnly = false) {
  return (async () => {
    const raw = await AsyncStorage.getItem(JUNLUO_INNER_STATE_KEYS.affect);
    if (raw === null) return createDefaultJunluoAffectState();
    try {
      const parsed: unknown = JSON.parse(raw);
      const upgraded = upgradeJunluoAffectState(parsed);
      if (!upgraded) return createDefaultJunluoAffectState();
      if (!readOnly && !isJunluoAffectStateV1(parsed)) {
        await AsyncStorage.setItem(
          JUNLUO_INNER_STATE_KEYS.affect,
          JSON.stringify(upgraded),
        );
      }
      return upgraded;
    } catch {
      return createDefaultJunluoAffectState();
    }
  })();
}

export function updateJunluoAffectState(
  update: (latest: JunluoAffectStateV1) => JunluoAffectStateV1,
  options: InnerWriteOptions & { relationshipChoiceOperationId?: string } = {},
): Promise<JunluoAffectStateV1 | null> {
  const epoch = options.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : options.dataEpoch;
  return runJunluoAffectWriteBoundary(async () => {
    let notifyChoice = false;
    let savedValue: JunluoAffectStateV1 | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        const saved = await runBackupRestoreDataEpochCommit(epoch, async () => {
          if (!canCommitBackupRestoreDataEpoch(epoch) || options.shouldCommit && !await options.shouldCommit()) return null;
          const current = await loadJunluoAffectState();
          const next = update(current);
          if (!canCommitBackupRestoreDataEpoch(epoch) || options.shouldCommit && !await options.shouldCommit()) return null;
          notifyChoice ||= current.relationshipChoice.value !== next.relationshipChoice.value
            || Boolean(options.relationshipChoiceOperationId && next.relationshipChoice.lastOperation?.operationId === options.relationshipChoiceOperationId);
          if (next !== current) await saveState(JUNLUO_INNER_STATE_KEYS.affect, next, isJunluoAffectStateV1);
          return next;
        });
        if (!saved.committed || !saved.value) return null;
        savedValue = saved.value;
        break;
      } catch (error) { if (attempt === 3 || !canCommitBackupRestoreDataEpoch(epoch)) throw error; }
    }
    // Neither a UI notification nor the desire writer's own retries may repeat this save loop.
    if (canCommitBackupRestoreDataEpoch(epoch)) {
      await Promise.all([import('react-native'), import('../ai/assistantState')]).then(async ([native, assistant]) => {
        const state = await assistant.loadAssistantState();
        if (canCommitBackupRestoreDataEpoch(epoch)) native.DeviceEventEmitter.emit(assistant.ASSISTANT_STATE_CHANGED_EVENT, { state });
      }).catch(() => undefined);
    }
    if (notifyChoice) {
      if (!canCommitBackupRestoreDataEpoch(epoch) || options.shouldCommit && !await options.shouldCommit()) return null;
      const { noteJunluoRelationshipChoice } = await import('./junluoDesireRuntime');
      await noteJunluoRelationshipChoice(savedValue.relationshipChoice.value, savedValue.relationshipChoice.updatedAt);
    }
    return savedValue;
  });
}

type JunluoInnerStatePair = {
  desire: JunluoDesireState;
  affect: JunluoAffectStateV1;
};

export function updateJunluoInnerStatePair(
  update: (latest: JunluoInnerStatePair) => JunluoInnerStatePair,
  options: InnerWriteOptions = {},
): Promise<JunluoInnerStatePair | null> {
  const epoch = options.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : options.dataEpoch;
  // Ordinary affect writes may enter the desire writer when their relationship choice changes.
  // Keep that same order; neither lock is held while waiting for a model.
  return runJunluoAffectWriteBoundary(async () => {
    const pair = await runJunluoDesireWriteBoundary(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const saved = await runBackupRestoreDataEpochCommit(epoch, async () => {
            if (options.shouldCommit && !await options.shouldCommit() || !canCommitBackupRestoreDataEpoch(epoch)) return null;
            const desire = await readDesireState();
            const rawAffect = await AsyncStorage.getItem(JUNLUO_INNER_STATE_KEYS.affect);
            let parsedAffect: unknown = null;
            if (rawAffect !== null) {
              try { parsedAffect = JSON.parse(rawAffect); } catch {
                throw new Error('已保存感受状态不是有效 JSON，未改写原数据。');
              }
            }
            const affect = rawAffect === null ? createDefaultJunluoAffectState() : upgradeJunluoAffectState(parsedAffect);
            if (!affect) throw new Error('已保存感受状态无法升级，未改写原数据。');
            const next = update({ desire: desire.state, affect });
            if (!isJunluoDesireState(next.desire) || !isJunluoAffectStateV1(next.affect)) {
              throw new Error('成对内部状态不符合严格合同。');
            }
            if (options.shouldCommit && !await options.shouldCommit() || !canCommitBackupRestoreDataEpoch(epoch)) return null;
            if (desire.migrated || rawAffect !== null && !isJunluoAffectStateV1(parsedAffect)
              || next.desire !== desire.state || next.affect !== affect) {
              // The existing Android storage batch commits both existing keys in one SQLite transaction.
              await AsyncStorage.multiSet([
                [JUNLUO_INNER_STATE_KEYS.desire, JSON.stringify(next.desire)],
                [JUNLUO_INNER_STATE_KEYS.affect, JSON.stringify(next.affect)],
              ]);
            }
            return next;
          });
          return saved.committed ? saved.value : null;
        } catch (error) {
          if (attempt === 3 || !canCommitBackupRestoreDataEpoch(epoch)) throw error;
        }
      }
    });
    if (pair && canCommitBackupRestoreDataEpoch(epoch)) {
      await Promise.all([import('react-native'), import('../ai/assistantState')]).then(async ([native, assistant]) => {
        const state = await assistant.loadAssistantState();
        if (canCommitBackupRestoreDataEpoch(epoch)) native.DeviceEventEmitter.emit(assistant.ASSISTANT_STATE_CHANGED_EVENT, { state });
      }).catch(() => undefined);
    }
    // The caller settles the relationship-choice clock in the same desire value, not a second write.
    return pair;
  });
}

export function loadJunluoThoughtState() {
  return (async () => {
    const raw = await AsyncStorage.getItem(JUNLUO_INNER_STATE_KEYS.thought);
    if (raw === null) return createDefaultJunluoThoughtState();
    try {
      const parsed: unknown = JSON.parse(raw);
      const upgraded = upgradeJunluoThoughtState(parsed);
      if (!upgraded) return createDefaultJunluoThoughtState();
      if (!isJunluoThoughtStateV2(parsed)) {
        await AsyncStorage.setItem(
          JUNLUO_INNER_STATE_KEYS.thought,
          JSON.stringify(upgraded),
        );
      }
      return upgraded;
    } catch {
      return createDefaultJunluoThoughtState();
    }
  })();
}

export function updateJunluoThoughtState(
  update: (latest: JunluoThoughtStateV2, retainedThoughtIds: ReadonlySet<string>) => JunluoThoughtStateV2,
  options: InnerWriteOptions = {},
): Promise<JunluoThoughtStateV2 | null> {
  const epoch = options.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : options.dataEpoch;
  const work = thoughtWriteTail.catch(() => undefined).then(async () => {
    const saved = await runBackupRestoreDataEpochCommit(epoch, async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          if (!canCommitBackupRestoreDataEpoch(epoch) || options.shouldCommit && !await options.shouldCommit()) return null;
          const current = await loadJunluoThoughtState();
          let retainedThoughtIds: ReadonlySet<string>;
          try {
            retainedThoughtIds = (await (await import('../memory/lifeSelfMemoryRetention')).loadLifeSelfRetainedIds()).wish;
          } catch {
            console.warn('life-self-wish-retention-read-failed');
            retainedThoughtIds = new Set(current.thoughts.map(thought => thought.thoughtId));
          }
          const next = update(current, retainedThoughtIds);
          if (!canCommitBackupRestoreDataEpoch(epoch) || options.shouldCommit && !await options.shouldCommit()) return null;
          if (next !== current) await saveState(JUNLUO_INNER_STATE_KEYS.thought, next, isJunluoThoughtStateV2);
          return next;
        } catch (error) { if (attempt === 3 || !canCommitBackupRestoreDataEpoch(epoch)) throw error; }
      }
    });
    return saved.committed ? saved.value : null;
  });
  thoughtWriteTail = work;
  return work;
}
