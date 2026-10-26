import { useEffect, useRef } from 'react';
import { AppState, InteractionManager } from 'react-native';

import type { ScreenName } from '../types/navigation';
import {
  loadMemoryDuplicateCleanupJournal,
  memoryDuplicateCleanupNeedsOneTimeDrain,
  subscribeMemoryDuplicateCleanupJournal,
} from '../memory/memoryDuplicateCleanupState';
import {
  registerAutomaticDataSyncBackgroundTask,
  unregisterAutomaticDataSyncBackgroundTask,
} from './automaticDataSyncBackgroundTask';
import { subscribeAutomaticDataSyncWorkAvailable } from './automaticDataSyncEvents';
import {
  loadAutomaticDataSyncPolicy,
  subscribeAutomaticDataSyncSnapshot,
} from './automaticDataSyncPolicy';
import {
  refreshAndroidAutomaticDataSyncProgress,
  runAndroidAutomaticDataSyncCheck,
} from './automaticDataSyncRuntime';
import { automaticDataSyncScreenAllowsFullRun } from './automaticDataSyncProgressCore';
import { pauseAutomaticDataSyncProgress } from './automaticDataSyncProgress';

const FOREGROUND_CHECK_INTERVAL_MS = 60_000;
const LOCAL_CHANGE_DEBOUNCE_MS = 10_000;
const RESUME_AFTER_BUSY_MS = 5_000;

type ForegroundAutomaticSyncSource =
  | 'cold-start'
  | 'foreground'
  | 'interval'
  | 'local-change'
  | 'resume';

export function useAutomaticDataSyncScheduler(input: {
  screen: ScreenName;
  screenRef: React.MutableRefObject<ScreenName>;
  chatBusy: boolean;
  exclusiveBusy: boolean;
  voiceCallActive: boolean;
}) {
  const fullSyncAllowed = automaticDataSyncScreenAllowsFullRun({
    screen: input.screen,
    chatBusy: input.chatBusy,
    exclusiveBusy: input.exclusiveBusy,
    voiceCallActive: input.voiceCallActive,
  });
  const previousFullSyncAllowed = useRef<boolean | null>(null);
  const runtimeGateRef = useRef({
    chatBusy: input.chatBusy,
    exclusiveBusy: input.exclusiveBusy,
    voiceCallActive: input.voiceCallActive,
  });
  runtimeGateRef.current = {
    chatBusy: input.chatBusy,
    exclusiveBusy: input.exclusiveBusy,
    voiceCallActive: input.voiceCallActive,
  };
  const checkRef = useRef<(source: ForegroundAutomaticSyncSource) => void>(
    () => undefined,
  );

  useEffect(() => {
    let disposed = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let interaction: ReturnType<typeof InteractionManager.runAfterInteractions>
      | null = null;
    let policyEnabled: boolean | null = null;
    let cleanupDrainEnabled: boolean | null = null;
    let backgroundRegistered: boolean | null = null;

    const check = (source: ForegroundAutomaticSyncSource) => {
      if (disposed || AppState.currentState !== 'active') return;
      const gate = runtimeGateRef.current;
      const allowFullSync = automaticDataSyncScreenAllowsFullRun({
        screen: input.screenRef.current,
        chatBusy: gate.chatBusy,
        exclusiveBusy: gate.exclusiveBusy,
        voiceCallActive: gate.voiceCallActive,
      });
      if (!allowFullSync) {
        void pauseAutomaticDataSyncProgress();
        void runAndroidAutomaticDataSyncCheck({ source, allowFullSync: false });
        return;
      }
      interaction?.cancel();
      interaction = InteractionManager.runAfterInteractions(() => {
        if (disposed || AppState.currentState !== 'active') return;
        const latestGate = runtimeGateRef.current;
        void runAndroidAutomaticDataSyncCheck({
          source,
          allowFullSync: automaticDataSyncScreenAllowsFullRun({
            screen: input.screenRef.current,
            chatBusy: latestGate.chatBusy,
            exclusiveBusy: latestGate.exclusiveBusy,
            voiceCallActive: latestGate.voiceCallActive,
          }),
        });
      });
    };
    checkRef.current = check;

    const reconcileRegistration = (source: ForegroundAutomaticSyncSource) => {
      if (
        disposed
        || policyEnabled === null
        || cleanupDrainEnabled === null
      ) return;
      const shouldRegister = policyEnabled || cleanupDrainEnabled;
      if (shouldRegister === backgroundRegistered) return;
      backgroundRegistered = shouldRegister;
      if (shouldRegister) {
        void registerAutomaticDataSyncBackgroundTask();
        check(source);
      } else {
        void unregisterAutomaticDataSyncBackgroundTask();
      }
    };

    void Promise.all([
      loadAutomaticDataSyncPolicy(),
      loadMemoryDuplicateCleanupJournal(),
    ]).then(([policy, cleanup]) => {
      if (disposed) return;
      policyEnabled = policy.enabled;
      cleanupDrainEnabled = memoryDuplicateCleanupNeedsOneTimeDrain(cleanup);
      reconcileRegistration('cold-start');
    });
    const interval = setInterval(() => check('interval'), FOREGROUND_CHECK_INTERVAL_MS);
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') check('foreground');
    });
    const unsubscribe = subscribeAutomaticDataSyncWorkAvailable(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        void refreshAndroidAutomaticDataSyncProgress();
        check('local-change');
      }, LOCAL_CHANGE_DEBOUNCE_MS);
    });
    const unsubscribePolicy = subscribeAutomaticDataSyncSnapshot((policy) => {
      if (policy.enabled === policyEnabled) return;
      policyEnabled = policy.enabled;
      reconcileRegistration('foreground');
    });
    const unsubscribeCleanup = subscribeMemoryDuplicateCleanupJournal((journal) => {
      const enabled = memoryDuplicateCleanupNeedsOneTimeDrain(journal);
      if (enabled === cleanupDrainEnabled) return;
      cleanupDrainEnabled = enabled;
      reconcileRegistration('local-change');
    });

    return () => {
      disposed = true;
      checkRef.current = () => undefined;
      clearInterval(interval);
      if (debounceTimer) clearTimeout(debounceTimer);
      interaction?.cancel();
      appState.remove();
      unsubscribe();
      unsubscribePolicy();
      unsubscribeCleanup();
    };
  }, [input.screenRef]);

  useEffect(() => {
    let resumeTimer: ReturnType<typeof setTimeout> | null = null;
    const previous = previousFullSyncAllowed.current;
    previousFullSyncAllowed.current = fullSyncAllowed;
    if (previous === false && fullSyncAllowed) {
      resumeTimer = setTimeout(
        () => checkRef.current('resume'),
        RESUME_AFTER_BUSY_MS,
      );
    } else if (!fullSyncAllowed) {
      void pauseAutomaticDataSyncProgress();
      checkRef.current('foreground');
    }
    return () => {
      if (resumeTimer) clearTimeout(resumeTimer);
    };
  }, [fullSyncAllowed]);
}
