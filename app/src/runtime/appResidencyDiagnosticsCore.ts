export const APP_RESIDENCY_MARKER_PREFIX = '[JunLuoAppResidency] ';

export const APP_RESIDENCY_SCREEN_CODES = {
  other: 0,
  home: 1,
  settings: 2,
  memory: 3,
  schedule: 4,
  focus: 5,
  chat: 6,
} as const;

export type AppResidencyScreen = keyof typeof APP_RESIDENCY_SCREEN_CODES;

export function normalizeAppResidencyScreen(screen: string): AppResidencyScreen {
  return Object.hasOwn(APP_RESIDENCY_SCREEN_CODES, screen)
    ? screen as AppResidencyScreen
    : 'other';
}

export type AppResidencyMountCounts = {
  chatMountCount: number;
  focusMountCount: number;
  homeMountCount: number;
  memoryMountCount: number;
  scheduleMountCount: number;
  settingsMountCount: number;
};

export type AppResidencyLifecycleInput = {
  chatMounted: boolean;
  focusMounted: boolean;
  homeMounted: boolean;
  scheduleMounted: boolean;
  screen: AppResidencyScreen;
};

export type AppResidencyLifecycleSnapshot = AppResidencyMountCounts & {
  activeScreenCode: number;
};

export type ChatRuntimeResidencySnapshot = {
  residentMessageCount: number;
  residentSessionCount: number;
};

export type ChatStorageResidencySnapshot = {
  serializedMessageRecordCount: number;
  serializedMessageRecordEstimatedBytes: number;
};

export type AppResidencySnapshot = AppResidencyLifecycleSnapshot
  & ChatRuntimeResidencySnapshot
  & ChatStorageResidencySnapshot
  & {
    stage: 'app.residency_snapshot';
    v: 1;
  };

type AppResidencyRecorderOptions = {
  emit: (line: string) => void;
  enabled: boolean;
  readChatRuntime: () => ChatRuntimeResidencySnapshot;
  readChatStorage: () => ChatStorageResidencySnapshot;
};

const emptyMountCounts = (): AppResidencyMountCounts => ({
  chatMountCount: 0,
  focusMountCount: 0,
  homeMountCount: 0,
  memoryMountCount: 0,
  scheduleMountCount: 0,
  settingsMountCount: 0,
});

export function summarizeChatRuntimeResidency(
  sessions: readonly { messages: readonly unknown[] }[],
): ChatRuntimeResidencySnapshot {
  let residentMessageCount = 0;
  let residentSessionCount = 0;
  for (const session of sessions) {
    if (session.messages.length === 0) continue;
    residentSessionCount += 1;
    residentMessageCount += session.messages.length;
  }
  return { residentMessageCount, residentSessionCount };
}

export function createAppResidencyLifecycleTracker() {
  const mountCounts = emptyMountCounts();
  let previousScreen: AppResidencyScreen | null = null;
  let previousChatMounted = false;
  let previousFocusMounted = false;
  let previousHomeMounted = false;
  let previousScheduleMounted = false;

  return {
    capture(input: AppResidencyLifecycleInput): AppResidencyLifecycleSnapshot {
      if (input.chatMounted && !previousChatMounted) mountCounts.chatMountCount += 1;
      if (input.focusMounted && !previousFocusMounted) mountCounts.focusMountCount += 1;
      if (input.homeMounted && !previousHomeMounted) mountCounts.homeMountCount += 1;
      if (input.scheduleMounted && !previousScheduleMounted) mountCounts.scheduleMountCount += 1;
      if (input.screen === 'memory' && previousScreen !== 'memory') mountCounts.memoryMountCount += 1;
      if (input.screen === 'settings' && previousScreen !== 'settings') mountCounts.settingsMountCount += 1;

      previousChatMounted = input.chatMounted;
      previousFocusMounted = input.focusMounted;
      previousHomeMounted = input.homeMounted;
      previousScheduleMounted = input.scheduleMounted;
      previousScreen = input.screen;

      return {
        activeScreenCode: APP_RESIDENCY_SCREEN_CODES[input.screen],
        ...mountCounts,
      };
    },
  };
}

export function createAppResidencyRecorder(options: AppResidencyRecorderOptions) {
  return {
    record(lifecycle: AppResidencyLifecycleSnapshot): AppResidencySnapshot | null {
      if (!options.enabled) return null;
      const snapshot: AppResidencySnapshot = {
        v: 1,
        stage: 'app.residency_snapshot',
        ...lifecycle,
        ...options.readChatRuntime(),
        ...options.readChatStorage(),
      };
      options.emit(`${APP_RESIDENCY_MARKER_PREFIX}${JSON.stringify(snapshot)}`);
      return snapshot;
    },
  };
}
