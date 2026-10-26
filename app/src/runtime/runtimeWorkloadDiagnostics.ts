export const RUNTIME_WORKLOAD_STAGES = [
  'font.bundle_load',
  'runtime.startup_queue',
  'runtime.foreground_queue',
  'runtime.foreground.notification_heal',
  'runtime.foreground.nearby_resume',
  'runtime.foreground.body_signal_resume',
  'runtime.foreground.phone_activity',
  'runtime.foreground.music_alarm',
  'runtime.deferred_ai',
  'runtime.deferred_trigger_cold',
  'runtime.deferred_trigger_foreground',
  'runtime.deferred_ambient',
  'runtime.deferred_persona',
  'runtime.deferred_life',
  'runtime.deferred_incoming',
  'runtime.life_tick',
  'runtime.incoming_messages',
  'runtime.incoming.schedule_reminders',
  'runtime.incoming.todo_reminders',
  'runtime.incoming.schedule_companion',
  'runtime.incoming.goal_cards',
  'runtime.incoming.letters',
  'runtime.incoming.proactive',
  'ambient.snapshot_actual',
  'ambient.system_status',
  'ambient.phone_activity',
  'tools.agent_runtime_import',
  'tools.audit.request',
  'tools.audit.permission',
  'tools.audit.started',
  'tools.audit.result_local',
  'tools.audit.result_final',
  'tools.audit.storage_load',
  'tools.audit.storage_serialize',
  'tools.audit.sync_prepare',
  'tools.audit.sync_queue',
  'tools.audit.sync_device',
  'tools.audit.sync_derive',
  'tools.audit.sync_capture',
  'tools.audit.storage_set',
  'tools.lifecycle.requested',
  'tools.lifecycle.permission',
  'tools.lifecycle.started',
  'tools.lifecycle.result',
  'tools.lifecycle.error',
  'tools.lifecycle.finished',
  'tools.backup_epoch_lease',
  'tools.executor',
  'system_status.battery_native',
  'system_status.time_build',
  'system_status.device_info',
  'system_status.result_build',
  'phone_activity.native_read',
  'phone_activity.sqlite_persist',
  'phone_activity.summary_query',
  'life.refresh_actual',
  'life.material_actual',
  'life.attention_actual',
  'life.desire_actual',
  'life.model_actual',
  'cognition.memory',
  'cognition.ambient',
  'cognition.nearby_world',
  'cognition.lightweight',
  'memory.recall',
  'embedding.request',
  'memory.snapshot',
  'memory.background',
  'memory.care_pool',
  'memory.current_state',
  'memory.anchor',
  'memory.reflection',
  'memory.source_trace',
  'memory.maintenance_actual',
  'memory.worker_reconcile',
  'memory.worker_batch',
  'memory.worker_job.embedding',
  'memory.worker_job.source_integrity',
  'memory.worker_job.duplicate_analysis',
  'memory.worker_job.continuation_analysis',
  'schedule.reminder_prewarm_dispatch',
  'schedule.reminder_supplement_actual',
  'home.mount_lifetime',
  'home.afterglow_effect_lifetime',
  'home.afterglow_initial_scan',
  'home.afterglow_recheck',
  'home.focus_invite_prepare',
  'chat.life_refresh',
  'chat.cognition_prewarm',
  'chat.full_state_load',
  'chat.fast_state_load',
  'app.screen.home_active',
  'app.screen.chat_active',
  'app.screen.settings_active',
  'app.screen.schedule_active',
  'app.screen.focus_active',
  'app.screen.memory_active',
  'app.mount.chat',
  'app.mount.schedule',
  'app.mount.focus',
  'database.memory.open',
  'database.memory.store_write',
  'database.memory.worker_write',
  'database.memory.ingestion_write',
  'database.memory.sync_capture_write',
  'database.memory.continuity_write',
  'database.memory.embedding_write',
  'database.memory.current_state_write',
  'database.memory.style_write',
  'database.memory.continuation_write',
  'database.memory.topic_profile_write',
  'database.memory.voice_write',
  'database.memory.store_operation_slow',
  'database.memory.store_transaction_slow',
  'database.memory.worker_operation_slow',
  'database.memory.worker_transaction_slow',
  'database.memory.ingestion_operation_slow',
  'database.memory.ingestion_transaction_slow',
  'database.memory.sync_capture_operation_slow',
  'database.memory.sync_capture_transaction_slow',
  'database.memory.continuity_operation_slow',
  'database.memory.continuity_transaction_slow',
  'database.memory.embedding_operation_slow',
  'database.memory.embedding_transaction_slow',
  'database.memory.current_state_operation_slow',
  'database.memory.current_state_transaction_slow',
  'database.memory.style_operation_slow',
  'database.memory.style_transaction_slow',
  'database.memory.continuation_operation_slow',
  'database.memory.continuation_transaction_slow',
  'database.memory.topic_profile_operation_slow',
  'database.memory.topic_profile_transaction_slow',
  'database.memory.voice_operation_slow',
  'database.memory.voice_transaction_slow',
  'database.sync.operation',
] as const;

export type RuntimeWorkloadStage = typeof RUNTIME_WORKLOAD_STAGES[number];
export type RuntimeWorkloadOutcome = 'ok' | 'failed' | 'cancelled' | 'timeout' | 'locked';
export type RuntimeWorkloadBudget = 'interactive' | 'connection-test' | 'background';
export type RuntimeWorkloadDiagnosticProfile = 'full' | 'memory-low-noise';
export type RuntimeWorkloadCounts = {
  activeMessageCount?: number;
  itemCount?: number;
  memoryCount?: number;
  messageCount?: number;
  sessionCount?: number;
};

export const RUNTIME_WORKLOAD_TIMING_KEYS = [
  'databaseOpenMs',
  'cleanupMs',
  'settingsLoadMs',
  'pageLoadMs',
  'itemTotalMs',
  'itemCommitMs',
  'sourceLoadMs',
  'sourceJobMs',
  'memoryLoadMs',
  'hashBuildMs',
  'indexLookupMs',
  'embeddingJobMs',
  'resultBuildMs',
] as const;

export type RuntimeWorkloadTimingKey = typeof RUNTIME_WORKLOAD_TIMING_KEYS[number];
export type RuntimeWorkloadTimings = Partial<Record<RuntimeWorkloadTimingKey, number>>;

export type RuntimeWorkloadSpan = {
  readonly token: number;
  startTiming: (key: RuntimeWorkloadTimingKey) => () => void;
  finish: (outcome?: RuntimeWorkloadOutcome, counts?: RuntimeWorkloadCounts) => void;
};

export type RuntimeWorkloadStartOptions = {
  budget?: RuntimeWorkloadBudget;
  parentToken?: number;
};

type RuntimeWorkloadRecorderOptions = {
  emit: (line: string) => void;
  enabled: boolean;
  now: () => number;
  shouldRecordStage?: (stage: RuntimeWorkloadStage) => boolean;
};

const MARKER_PREFIX = '[JunLuoRuntimeWorkload] ';
const MEMORY_LOW_NOISE_SKIPPED_STAGES = new Set<RuntimeWorkloadStage>([
  'database.memory.worker_write',
  'database.sync.operation',
]);

export function shouldRecordRuntimeWorkloadStage(
  stage: RuntimeWorkloadStage,
  profile: RuntimeWorkloadDiagnosticProfile = 'full',
) {
  return profile !== 'memory-low-noise' || !MEMORY_LOW_NOISE_SKIPPED_STAGES.has(stage);
}

function rounded(value: number) {
  return Math.round(value * 100) / 100;
}

function normalizedCount(value: number | undefined) {
  return Number.isFinite(value) && value! >= 0 ? Math.trunc(value!) : undefined;
}

function normalizedToken(value: number | undefined) {
  return Number.isInteger(value) && value! > 0 ? value : undefined;
}

function normalizedBudget(value: RuntimeWorkloadBudget | undefined) {
  return value === 'interactive' || value === 'connection-test' || value === 'background'
    ? value
    : undefined;
}

export function createRuntimeWorkloadRecorder(options: RuntimeWorkloadRecorderOptions) {
  let nextToken = 0;

  const start = (
    stage: RuntimeWorkloadStage,
    startOptions: RuntimeWorkloadStartOptions = {},
  ): RuntimeWorkloadSpan | null => {
    if (!options.enabled || options.shouldRecordStage?.(stage) === false) return null;

    const token = ++nextToken;
    const budget = normalizedBudget(startOptions.budget);
    const parentToken = normalizedToken(startOptions.parentToken);
    const startedAt = options.now();
    const timings: RuntimeWorkloadTimings = {};
    options.emit(`${MARKER_PREFIX}${JSON.stringify({
      v: 2,
      stage,
      phase: 'start',
      token,
      ...(budget === undefined ? {} : { budget }),
      ...(parentToken === undefined ? {} : { parentToken }),
    })}`);

    let finished = false;
    return {
      token,
      startTiming(key) {
        if (finished) return () => undefined;
        const timingStartedAt = options.now();
        let timingFinished = false;
        return () => {
          if (timingFinished || finished) return;
          timingFinished = true;
          const durationMs = Math.max(0, options.now() - timingStartedAt);
          timings[key] = (timings[key] ?? 0) + durationMs;
        };
      },
      finish(outcome = 'ok', counts = {}) {
        if (finished) return;
        finished = true;
        const activeMessageCount = normalizedCount(counts.activeMessageCount);
        const itemCount = normalizedCount(counts.itemCount);
        const memoryCount = normalizedCount(counts.memoryCount);
        const messageCount = normalizedCount(counts.messageCount);
        const sessionCount = normalizedCount(counts.sessionCount);
        options.emit(`${MARKER_PREFIX}${JSON.stringify({
          v: 2,
          stage,
          phase: 'end',
          token,
          ...(budget === undefined ? {} : { budget }),
          ...(parentToken === undefined ? {} : { parentToken }),
          durationMs: rounded(Math.max(0, options.now() - startedAt)),
          outcome,
          ...(activeMessageCount === undefined ? {} : { activeMessageCount }),
          ...(itemCount === undefined ? {} : { itemCount }),
          ...(memoryCount === undefined ? {} : { memoryCount }),
          ...(messageCount === undefined ? {} : { messageCount }),
          ...(sessionCount === undefined ? {} : { sessionCount }),
          ...(Object.keys(timings).length === 0 ? {} : {
            timings: Object.fromEntries(
              RUNTIME_WORKLOAD_TIMING_KEYS.flatMap((key) => (
                timings[key] === undefined ? [] : [[key, rounded(timings[key]!)] as const]
              )),
            ),
          }),
        })}`);
      },
    };
  };

  const observe = <T>(
    stage: RuntimeWorkloadStage,
    operation: (span?: RuntimeWorkloadSpan) => Promise<T>,
    summarize?: (value: T) => RuntimeWorkloadCounts,
    startOptions: RuntimeWorkloadStartOptions = {},
  ): Promise<T> => {
    if (!options.enabled) return operation();
    const span = start(stage, startOptions);
    if (!span) return operation();
    let pending: Promise<T>;
    try {
      pending = operation(span);
    } catch (error) {
      span.finish('failed');
      throw error;
    }
    return pending.then(
      (value) => {
        span.finish('ok', summarize?.(value));
        return value;
      },
      (error) => {
        span.finish('failed');
        throw error;
      },
    );
  };

  return { observe, start };
}

export const runtimeWorkloadDiagnosticsEnabled =
  process.env.EXPO_PUBLIC_JUNLUO_WORKLOAD_DIAGNOSTICS === '1';
export const runtimeWorkloadDiagnosticProfile: RuntimeWorkloadDiagnosticProfile =
  process.env.EXPO_PUBLIC_JUNLUO_WORKLOAD_DIAGNOSTICS_PROFILE === 'memory-low-noise'
    ? 'memory-low-noise'
    : 'full';

const runtimeWorkloadRecorder = createRuntimeWorkloadRecorder({
  enabled: runtimeWorkloadDiagnosticsEnabled,
  emit: (line) => console.info(line),
  now: () => (
    typeof globalThis.performance?.now === 'function'
      ? globalThis.performance.now()
      : Date.now()
  ),
  shouldRecordStage: (stage) => shouldRecordRuntimeWorkloadStage(
    stage,
    runtimeWorkloadDiagnosticProfile,
  ),
});

export function isRuntimeWorkloadStageEnabled(stage: RuntimeWorkloadStage) {
  return runtimeWorkloadDiagnosticsEnabled
    && shouldRecordRuntimeWorkloadStage(stage, runtimeWorkloadDiagnosticProfile);
}
export const beginRuntimeWorkload = runtimeWorkloadRecorder.start;
export const observeRuntimeWorkload = runtimeWorkloadRecorder.observe;
