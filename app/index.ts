import { AppRegistry } from 'react-native';
import { registerRootComponent } from 'expo';
import { registerGlobals } from '@livekit/react-native';

registerGlobals();
const App = require('./App').default;
AppRegistry.registerComponent('JunLuoPhoneLockChat', () => require('./src/phoneRestriction/phoneLockChatSurface').PhoneLockChatSurface);
const { runBackupProtectedTask } = require('./src/backup/backupService');

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);

AppRegistry.registerHeadlessTask('JunLuoChatReplyBackgroundTask', () => async payload => {
  const { holdChatReplyBackgroundTask } = await import('./src/chat/chatReplyBackground');
  await holdChatReplyBackgroundTask(payload);
});

AppRegistry.registerHeadlessTask('JunLuoShiyingBackfillBackgroundTask', () => async payload => {
  const { holdShiyingBackfillBackgroundTask } = await import('./src/shiying/shiyingBackfillBackground');
  await holdShiyingBackfillBackgroundTask(payload);
});

// React Native's final catch otherwise reports only the SQLite error, losing
// the background entry that failed. Keep its cause; never retry or log payloads.
async function diagnoseHeadlessTask(name: string, work: () => Promise<void>, context?: () => string) {
  try {
    await work();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'background-task-failed';
    const detail = context?.();
    throw new Error(`[headless:${name}${detail ? `:${detail}` : ''}] ${message}`, { cause });
  }
}

function phoneGuardDiagnosticPhase(payload: unknown) {
  const raw = typeof payload === 'string' ? payload
    : payload && typeof payload === 'object' && 'payloadJson' in payload
      ? payload.payloadJson : undefined;
  if (typeof raw !== 'string') return 'unknown';
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return 'unknown';
    if ('phase' in parsed && parsed.phase === 'body_signal_care') return 'body-signal-care';
    if ('phase' in parsed && parsed.phase === 'phone_care_follow_up') return 'phone-care-follow-up';
    if ('phase' in parsed) return 'unknown';
    return 'phone-guard';
  } catch { return 'unknown'; }
}

AppRegistry.registerHeadlessTask('JunLuoSleepScheduleTask', () => (payload) => diagnoseHeadlessTask('JunLuoSleepScheduleTask', async () => {
  // Check recovery before entry; each write in this runtime owns a short epoch
  // commit. A remote request must not hold the restore lease while waiting.
  const ready = await runBackupProtectedTask(async () => true);
  if (!ready.ran) return;
  const { handleSleepPlanTask } = await import('./src/life/sleepPlanRuntime');
  await handleSleepPlanTask(payload);
}));

AppRegistry.registerHeadlessTask('JunLuoScheduleReminderTask', () => (payload) => diagnoseHeadlessTask('JunLuoScheduleReminderTask', async () => {
  if (typeof payload?.eventId === 'string' && payload.eventId.startsWith('chat-reminder:')) {
    const ready = await runBackupProtectedTask(async () => true);
    if (!ready.ran) return;
    const { handleChatReminderWake } = await import('./src/schedule/chatReminderWake');
    await handleChatReminderWake(payload);
    return;
  }
  await runBackupProtectedTask(async () => {
    const { handleScheduleReminderTask } = await import('./src/schedule/scheduleReminderRuntime');
    await handleScheduleReminderTask(payload);
  });
}));

AppRegistry.registerHeadlessTask('PhoneGuardTriggerTask', () => (payload) => {
  const phase = phoneGuardDiagnosticPhase(payload);
  let stage = 'restore-check';
  return diagnoseHeadlessTask('PhoneGuardTriggerTask', async () => {
    await runBackupProtectedTask(async () => {
      stage = 'load-handler';
      const { handlePhoneGuardTriggerTask } = await import('./src/proactive/proactiveMessages');
      stage = 'dispatch';
      await handlePhoneGuardTriggerTask(payload, (nextStage) => { stage = nextStage; });
    });
  }, () => `${phase}/${stage}`);
});

AppRegistry.registerHeadlessTask('JunLuoCameraObservationTask', () => (payload) => diagnoseHeadlessTask('JunLuoCameraObservationTask', async () => {
  const { handleCameraAutomaticObservationHeadlessTask } = await import(
    './src/camera/cameraAutomaticObservationRuntime'
  );
  await handleCameraAutomaticObservationHeadlessTask(payload, runBackupProtectedTask);
}));
