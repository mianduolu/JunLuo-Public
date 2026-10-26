import * as Notifications from 'expo-notifications';
import { useEffect, useRef, type MutableRefObject } from 'react';
import { AppState, InteractionManager } from 'react-native';

import { prewarmAmbientContext } from '../ai/ambientContext';
import { prewarmPersonaPrompt } from '../ai/builtInSystemPrompt';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import type { AiConnection, AiProfile } from '../ai/types';
import { runBackupProtectedTask } from '../backup/backupService';
import { healPendingNotificationProjectionIfPermitted } from '../backup/restoreNotificationState';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { resumeBodySignalRuntime } from '../bodySignal/bodySignalRuntime';
import { hasPendingSleepingReply } from '../chat/sleepInteraction';
import { deliverDueLetters } from '../letters/letterDelivery';
import { initializeLetterNotifications, observeLetterNotifications } from '../letters/letterNotifications';
import { LIFE_ENGINE_FOREGROUND_INTERVAL_MS, runLifeTick } from '../life/lifeEngine';
import { registerJunluoLifeBackgroundTask } from '../life/lifeBackgroundTask';
import { resumeNearbyWorldPrecisionWatcherIfNeeded, syncNearbyWorldBackgroundTask } from '../nearby/nearbyWorldService';
import { maybeSendProactiveMessage, probePhoneActivityProactiveMessage } from '../proactive/proactiveMessages';
import { runPhoneCareFollowUp } from '../proactive/phoneCareFollowUpRuntime';
import { requestCorrespondenceTab } from '../posts/baiyunPostStore';
import { isPostNotificationPayload } from '../posts/baiyunPostNotificationPolicy';
import { observePostNotifications, openPostNotification } from '../posts/baiyunPostNotifications';
import { runDueMusicAlarms } from '../schedule/alarmMusicRunner';
import { tickChatReminderDelivery, handleChatReminderMusicAction } from '../schedule/chatReminderDelivery';
import { prepareStandaloneRemindersIndependently } from '../schedule/chatReminderPreparation';
import { nextChatReminderWakeAt } from '../schedule/chatReminderWake';
import {
  loadNextPendingMusicAlarmAt,
  subscribeAlarmRecordsChanged,
} from '../schedule/alarmStore';
import { deliverPendingGoalTimeCreditCards } from '../schedule/goalTimeCreditDelivery';
import {
  initializeScheduleNotifications,
  observeScheduleNotifications,
  syncScheduleNotifications,
} from '../schedule/scheduleNotifications';
import { deliverDueTodoReminderMessages } from '../schedule/todoReminderMessages';
import type { ScreenName } from '../types/navigation';
import { startShiyingRecordRuntime } from '../shiying/shiyingRecordRuntime';
import { createShiyingImageRuntime } from '../shiying/shiyingImageRuntime';
import { createShiyingAutomaticRuntime } from '../shiying/shiyingAutomaticRuntime';
import { createShiyingReviewRuntime } from '../shiying/shiyingReviewRuntime';
import { isShiyingNotificationDomain, isShiyingNotificationPayload, type ShiyingOpenRequest } from '../shiying/shiyingNotificationPolicy';
import { observeShiyingNotifications, dismissShiyingBatchNotification } from '../shiying/shiyingNotifications';
import {
  createCoalescedSingleFlightTask,
  createSerialRuntimeQueue,
  getRuntimeTimerDelay,
} from './appRuntimeSchedulerCore';
import {
  isAutomaticRemoteAiAllowed,
  isTechnicalRuntimeSilentScreen,
  loadAutomaticRemoteAiPolicy,
} from './automaticRemoteAiPolicy';
import { beginRuntimeWorkload, observeRuntimeWorkload } from './runtimeWorkloadDiagnostics';

const INCOMING_MESSAGE_POLL_INTERVAL_MS = 60 * 1000;
const PHONE_ACTIVITY_MESSAGE_POLL_INTERVAL_MS = 2000;
const DEFERRED_AI_COLD_START_DELAY_MS = 30_000;
const DEFERRED_AI_FOREGROUND_DELAY_MS = 8000;

type RuntimeOptions = {
  chatConnection: AiConnection | undefined;
  chatKey: string;
  consumePhoneGuardChatLaunch: () => void;
  enabled: boolean;
  enqueueScheduleMessages: (messages: SubjectiveMessage[]) => void;
  handledNotificationResponseIdsRef: MutableRefObject<Set<string>>;
  isChatMessageNotificationData: (value: unknown) => boolean;
  isReminderNotificationData: (value: unknown) => boolean;
  memoryOrganizerConnection: AiConnection | undefined;
  memoryOrganizerKey: string;
  navigate: (screen: ScreenName) => void;
  onOpenShiyingNotification?: (request: ShiyingOpenRequest) => void;
  openChatFromMessageSurface: () => void;
  profile: AiProfile;
  scheduleChatRefresh: (delayMs?: number, afterInteractions?: boolean) => void;
  screenRef: MutableRefObject<ScreenName>;
};

export function useAppRuntimeScheduler(options: RuntimeOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!options.enabled) return undefined;

    const shiyingImages = createShiyingImageRuntime({
      isActive: () => AppState.currentState === 'active',
      canRequest: async () => isAutomaticRemoteAiAllowed(
        await loadAutomaticRemoteAiPolicy(), optionsRef.current.screenRef.current,
      ),
    });
    const stopShiyingRecordRuntime = startShiyingRecordRuntime({ onSettled: shiyingImages.wake });
    const shiyingAutomatic = createShiyingAutomaticRuntime({
      isActive: () => AppState.currentState === 'active',
      screen: () => optionsRef.current.screenRef.current,
    });
    shiyingAutomatic.wake();
    const shiyingReviews = createShiyingReviewRuntime({
      isActive: () => AppState.currentState === 'active',
      screen: () => optionsRef.current.screenRef.current,
    });
    shiyingReviews.wake();
    const stopShiyingNotifications = observeShiyingNotifications();

    let stopped = false;
    let deferredAiTimer: ReturnType<typeof setTimeout> | null = null;
    let musicAlarmTimer: ReturnType<typeof setTimeout> | null = null;
    let chatReminderTimer: ReturnType<typeof setTimeout> | null = null;
    let receiveInFlight = false;
    let receiveQueued = false;
    let receiveQueuedIncludeAi = false;

    const receiveIncomingMessages = async (
      opened: boolean,
      includeAi = false,
      diagnosticParentToken?: number,
    ) => {
      if (receiveInFlight) {
        receiveQueued = true;
        receiveQueuedIncludeAi = receiveQueuedIncludeAi || includeAi;
        if (opened && optionsRef.current.screenRef.current !== 'focus') {
          optionsRef.current.navigate('chat');
        }
        return;
      }
      receiveInFlight = true;
      try {
        const current = optionsRef.current;
        const automaticRemoteAiEnabled = includeAi && isAutomaticRemoteAiAllowed(
          await loadAutomaticRemoteAiPolicy(),
          current.screenRef.current,
        );
        let inserted = 0;
        const deliveredScheduleMessages: SubjectiveMessage[] = [];
        try {
          const result = await observeRuntimeWorkload(
            'runtime.incoming.todo_reminders',
            () => deliverDueTodoReminderMessages(),
            (value) => ({ itemCount: value.messages.length }),
            { parentToken: diagnosticParentToken },
          );
          inserted += result.inserted;
          deliveredScheduleMessages.push(...result.messages);
        } catch {
          // One reminder source must not block the remaining incoming work.
        }
        // Local letter projection/ingestion recovery also runs on cold start and
        // foreground entry; remote generation keeps the existing AI gate.
        try {
          const letterResult = await observeRuntimeWorkload(
            'runtime.incoming.letters',
            () => deliverDueLetters({
              apiKey: automaticRemoteAiEnabled ? current.chatKey : undefined,
              backupRestoreLeaseHeld: true,
              connection: automaticRemoteAiEnabled ? current.chatConnection : undefined,
              memoryOrganizerConnection: automaticRemoteAiEnabled
                ? current.memoryOrganizerConnection
                : undefined,
              memoryOrganizerKey: automaticRemoteAiEnabled
                ? current.memoryOrganizerKey
                : undefined,
              profile: current.profile,
            }),
            (value) => ({ itemCount: value.delivered }),
            { parentToken: diagnosticParentToken },
          );
          inserted += letterResult.delivered;
        } catch {
          // Letter delivery must not block the remaining incoming work.
        }
        if (includeAi) {
          try {
            const goalCards = await observeRuntimeWorkload(
              'runtime.incoming.goal_cards',
              () => deliverPendingGoalTimeCreditCards({
                apiKey: automaticRemoteAiEnabled ? current.chatKey : undefined,
                connection: automaticRemoteAiEnabled
                  ? current.chatConnection ?? undefined
                  : undefined,
              }),
              (value) => ({ itemCount: value.length }),
              { parentToken: diagnosticParentToken },
            );
            inserted += goalCards.length;
          } catch {
            // Missing estimates remain pending until AI is available again.
          }
          current.enqueueScheduleMessages(deliveredScheduleMessages);

          if (automaticRemoteAiEnabled) {
            try {
              inserted += await observeRuntimeWorkload(
                'runtime.incoming.proactive',
                () => maybeSendProactiveMessage({
                  apiKey: current.chatKey,
                  backupRestoreLeaseHeld: true,
                  connection: current.chatConnection,
                  profile: current.profile,
                }),
                (value) => ({ itemCount: value }),
                { parentToken: diagnosticParentToken },
              );
            } catch {
              // Proactive delivery must not block the remaining incoming work.
            }
          }
        }
        if (inserted) {
          if (opened && current.screenRef.current !== 'focus') {
            current.navigate('chat');
            current.scheduleChatRefresh(700);
          } else {
            current.scheduleChatRefresh(current.screenRef.current === 'chat' ? 700 : 0);
          }
        } else if (opened && current.screenRef.current !== 'focus') {
          current.navigate('chat');
        }
      } finally {
        receiveInFlight = false;
        if (receiveQueued && !stopped) {
          const nextIncludeAi = receiveQueuedIncludeAi;
          receiveQueued = false;
          receiveQueuedIncludeAi = false;
          setTimeout(() => {
            void runBackupProtectedTask(
              () => receiveIncomingMessages(false, nextIncludeAi),
            ).catch(() => undefined);
          }, 200);
        }
      }
    };

    const receiveProtected = (
      opened: boolean,
      includeAi = false,
      diagnosticParentToken?: number,
    ) => (
      observeRuntimeWorkload(
        'runtime.incoming_messages',
        (span) => runBackupProtectedTask(
          () => receiveIncomingMessages(opened, includeAi, span?.token),
        )
          .catch(() => undefined),
        undefined,
        { parentToken: diagnosticParentToken },
      )
    );

    const receiveScheduleCompanionNotification = (opened: boolean) => {
      const current = optionsRef.current;
      if (opened && current.screenRef.current !== 'focus') current.navigate('chat');
      current.scheduleChatRefresh(opened ? 0 : current.screenRef.current === 'chat' ? 700 : 0, !opened);
    };

    const lifeTask = createCoalescedSingleFlightTask(() => (
      observeRuntimeWorkload('runtime.life_tick', async (span) => {
        const current = optionsRef.current;
        if (isTechnicalRuntimeSilentScreen(current.screenRef.current)) return;
        const automaticRemoteAiEnabled = (await loadAutomaticRemoteAiPolicy()).enabled;
        await runBackupProtectedTask(async () => {
          const result = await runLifeTick({
            apiKey: automaticRemoteAiEnabled ? current.chatKey : undefined,
            backupRestoreLeaseHeld: true,
            chatApiKey: automaticRemoteAiEnabled ? current.chatKey : undefined,
            chatConnection: automaticRemoteAiEnabled ? current.chatConnection : undefined,
            connection: automaticRemoteAiEnabled ? current.chatConnection : undefined,
            force: false,
            localOnly: !automaticRemoteAiEnabled,
            profile: current.profile,
            source: 'foreground',
            diagnosticParentToken: span?.token,
          }).catch(() => null);
          const wokeWithPendingChat = result?.afterLifeMode !== undefined
            && result.afterLifeMode !== 'sleeping'
            && await hasPendingSleepingReply();
          if (result?.proactiveMessageInserted || wokeWithPendingChat) {
            current.scheduleChatRefresh(current.screenRef.current === 'chat' ? 700 : 0);
          }
        }).catch(() => undefined);
      })
    ));

    const phoneActivityTask = createCoalescedSingleFlightTask(async () => {
      if (isTechnicalRuntimeSilentScreen(optionsRef.current.screenRef.current)) return;
      const inserted = await probePhoneActivityProactiveMessage({
        runTriggered: async (task) => {
          const result = await runBackupProtectedTask(task);
          return result.ran ? result.value : 0;
        },
      }).catch(() => 0);
      const followedUp = await runPhoneCareFollowUp();
      const current = optionsRef.current;
      if (inserted || followedUp) {
        current.scheduleChatRefresh(current.screenRef.current === 'chat' ? 700 : 0);
      }
    });

    let musicAlarmArmTask: ReturnType<typeof createCoalescedSingleFlightTask>;
    const musicAlarmRunTask = createCoalescedSingleFlightTask(async () => {
      await runBackupProtectedTask(
        () => runDueMusicAlarms(Date.now(), { backupRestoreLeaseHeld: true }),
      ).catch(() => undefined);
      await musicAlarmArmTask.run();
    });
    musicAlarmArmTask = createCoalescedSingleFlightTask(async () => {
      if (musicAlarmTimer) {
        clearTimeout(musicAlarmTimer);
        musicAlarmTimer = null;
      }
      const nextTriggerAt = await loadNextPendingMusicAlarmAt();
      if (stopped || nextTriggerAt === null) return;
      const delayMs = getRuntimeTimerDelay(nextTriggerAt);
      if (delayMs === null) return;
      musicAlarmTimer = setTimeout(() => {
        musicAlarmTimer = null;
        void musicAlarmRunTask.run();
      }, delayMs);
    });
    let chatReminderArmTask: ReturnType<typeof createCoalescedSingleFlightTask>;
    const chatReminderRunTask = createCoalescedSingleFlightTask(async () => {
      const ready = await runBackupProtectedTask(async () => true);
      if (!ready.ran || stopped) return;
      const result = await tickChatReminderDelivery().catch(() => null);
      if (result?.inserted) optionsRef.current.scheduleChatRefresh(0);
      // Preparation owns only short local commits, never this runtime's restore lease.
      void prepareStandaloneRemindersIndependently().catch(() => undefined);
      await chatReminderArmTask.run();
    });
    chatReminderArmTask = createCoalescedSingleFlightTask(async () => {
      if (chatReminderTimer) { clearTimeout(chatReminderTimer); chatReminderTimer = null; }
      const next = await nextChatReminderWakeAt();
      if (stopped || next === null) return;
      const delay = getRuntimeTimerDelay(next);
      if (delay !== null) chatReminderTimer = setTimeout(() => { chatReminderTimer = null; void chatReminderRunTask.run(); }, delay);
    });

    const runDeferredAiStartup = createCoalescedSingleFlightTask(() => (
      observeRuntimeWorkload('runtime.deferred_ai', async (span) => {
        const current = optionsRef.current;
        if (isTechnicalRuntimeSilentScreen(current.screenRef.current)) return;
        const automaticRemoteAiEnabled = (await loadAutomaticRemoteAiPolicy()).enabled;
        await observeRuntimeWorkload(
          'runtime.deferred_ambient',
          (childSpan) => prewarmAmbientContext(childSpan?.token).catch(() => undefined),
          undefined,
          { parentToken: span?.token },
        );
        await observeRuntimeWorkload(
          'runtime.deferred_persona',
          () => prewarmPersonaPrompt().catch(() => undefined),
          undefined,
          { parentToken: span?.token },
        );
        await observeRuntimeWorkload(
          'runtime.deferred_life',
          (childSpan) => runBackupProtectedTask(async () => {
            const result = await runLifeTick({
              apiKey: automaticRemoteAiEnabled ? current.chatKey : undefined,
              backupRestoreLeaseHeld: true,
              connection: automaticRemoteAiEnabled ? current.chatConnection : undefined,
              diagnosticParentToken: childSpan?.token,
              force: true,
              localOnly: !automaticRemoteAiEnabled,
              profile: current.profile,
              source: 'active',
            }).catch(() => null);
            if (result?.proactiveMessageInserted) {
              current.scheduleChatRefresh(current.screenRef.current === 'chat' ? 700 : 0);
            }
          }).catch(() => undefined),
          undefined,
          { parentToken: span?.token },
        );
        await observeRuntimeWorkload(
          'runtime.deferred_incoming',
          (childSpan) => receiveProtected(false, true, childSpan?.token),
          undefined,
          { parentToken: span?.token },
        );
      })
    ));

    const scheduleDeferredAiStartup = (
      delayMs: number,
      trigger: 'cold' | 'foreground',
    ) => {
      if (deferredAiTimer) clearTimeout(deferredAiTimer);
      deferredAiTimer = setTimeout(() => {
        deferredAiTimer = null;
        const triggerSpan = beginRuntimeWorkload(
          trigger === 'cold'
            ? 'runtime.deferred_trigger_cold'
            : 'runtime.deferred_trigger_foreground',
        );
        triggerSpan?.finish();
        if (isTechnicalRuntimeSilentScreen(optionsRef.current.screenRef.current)) {
          return;
        }
        void runDeferredAiStartup.run();
      }, delayMs);
    };

    const runtimeResumeQueue = createSerialRuntimeQueue();
    const startupTask = createCoalescedSingleFlightTask(() => runtimeResumeQueue.enqueue(() => (
      observeRuntimeWorkload('runtime.startup_queue', async (span) => {
        await runBackupProtectedTask(async () => {
          await initializeScheduleNotifications();
          await syncScheduleNotifications();
          await initializeLetterNotifications();
          await healPendingNotificationProjectionIfPermitted();
        }).catch(() => undefined);
        await runBackupProtectedTask(() => syncNearbyWorldBackgroundTask()).catch(() => undefined);
        await runBackupProtectedTask(() => resumeNearbyWorldPrecisionWatcherIfNeeded()).catch(() => undefined);
        await runBackupProtectedTask(() => resumeBodySignalRuntime('startup')).catch(() => undefined);
        await receiveProtected(false, false, span?.token);
        await phoneActivityTask.run();
      })
    )));

    const foregroundTask = createCoalescedSingleFlightTask(() => runtimeResumeQueue.enqueue(() => (
      observeRuntimeWorkload('runtime.foreground_queue', async (span) => {
        optionsRef.current.consumePhoneGuardChatLaunch();
        await observeRuntimeWorkload(
          'runtime.foreground.notification_heal',
          () => runBackupProtectedTask(() => healPendingNotificationProjectionIfPermitted()),
          undefined,
          { parentToken: span?.token },
        ).catch(() => undefined);
        await observeRuntimeWorkload(
          'runtime.foreground.nearby_resume',
          () => runBackupProtectedTask(() => resumeNearbyWorldPrecisionWatcherIfNeeded()),
          undefined,
          { parentToken: span?.token },
        ).catch(() => undefined);
        await observeRuntimeWorkload(
          'runtime.foreground.body_signal_resume',
          () => runBackupProtectedTask(() => resumeBodySignalRuntime('foreground')),
          undefined,
          { parentToken: span?.token },
        ).catch(() => undefined);
        await receiveProtected(false, false, span?.token);
        await observeRuntimeWorkload(
          'runtime.foreground.phone_activity',
          () => phoneActivityTask.run(),
          undefined,
          { parentToken: span?.token },
        );
        await observeRuntimeWorkload(
          'runtime.foreground.music_alarm',
          () => musicAlarmArmTask.run(),
          undefined,
          { parentToken: span?.token },
        );
        scheduleDeferredAiStartup(DEFERRED_AI_FOREGROUND_DELAY_MS, 'foreground');
      })
    )));

    void registerJunluoLifeBackgroundTask();
    void musicAlarmArmTask.run();
    const startupInteraction = InteractionManager.runAfterInteractions(() => {
      void startupTask.run();
      scheduleDeferredAiStartup(DEFERRED_AI_COLD_START_DELAY_MS, 'cold');
    });

    const incomingInterval = setInterval(() => {
      if (AppState.currentState === 'active') void receiveProtected(false);
      if (AppState.currentState === 'active') void chatReminderRunTask.run();
    }, INCOMING_MESSAGE_POLL_INTERVAL_MS);
    const phoneActivityInterval = setInterval(() => {
      if (AppState.currentState === 'active') void phoneActivityTask.run();
    }, PHONE_ACTIVITY_MESSAGE_POLL_INTERVAL_MS);
    const lifeInterval = setInterval(() => {
      if (AppState.currentState === 'active') void lifeTask.run();
    }, LIFE_ENGINE_FOREGROUND_INTERVAL_MS);

    const stopAlarmObserver = subscribeAlarmRecordsChanged(() => {
      void musicAlarmArmTask.run();
      void chatReminderArmTask.run();
      void syncScheduleNotifications().catch(() => undefined);
    });
    void chatReminderRunTask.run();
    void Notifications.setNotificationCategoryAsync('junluo-chat-reminder-music', [
      { identifier: 'reminder-stop', buttonTitle: '停止', options: { opensAppToForeground: true } },
      { identifier: 'reminder-snooze', buttonTitle: '稍后十分钟', options: { opensAppToForeground: true } },
    ]).catch(() => undefined);
    const stopScheduleObserver = observeScheduleNotifications((opened, companion) => {
      if (companion) {
        // Notification taps, including cold launches, are handled once below.
        if (!opened) receiveScheduleCompanionNotification(false);
        return;
      }
      void receiveProtected(opened, opened);
    });
    const stopLetterObserver = observeLetterNotifications((opened) => {
      void receiveProtected(false, opened);
      if (opened && optionsRef.current.screenRef.current !== 'focus') {
        requestCorrespondenceTab('letters');
        optionsRef.current.navigate('letter');
      }
    });

    const stopPostObserver = observePostNotifications();
    const handleNotificationResponse = (response: Notifications.NotificationResponse) => {
      const current = optionsRef.current;
      const postData = response.notification.request.content.data;
      if (typeof postData.reminderOccurrenceId === 'string' && typeof postData.reminderAttemptId === 'string') {
        if (stopped) return;
        const operationId = `${response.notification.request.identifier}:${response.actionIdentifier}:${postData.reminderAttemptId}`;
        if (current.handledNotificationResponseIdsRef.current.has(operationId)) return;
        current.handledNotificationResponseIdsRef.current.add(operationId);
        if (response.actionIdentifier === 'reminder-stop' || response.actionIdentifier === 'reminder-snooze') {
          void handleChatReminderMusicAction({ occurrenceId: postData.reminderOccurrenceId, attemptId: postData.reminderAttemptId,
            operationId, action: response.actionIdentifier === 'reminder-stop' ? 'stop' : 'snooze' }).then(() => chatReminderArmTask.run()).catch(() => undefined);
        } else current.openChatFromMessageSurface();
        return;
      }
      if (isShiyingNotificationDomain(postData)) {
        // This domain never falls through to chat/reminder work, even for damaged payloads.
        if (stopped || !isShiyingNotificationPayload(postData)) return;
        const epoch = captureBackupRestoreDataEpoch();
        if (epoch === null || !canCommitBackupRestoreDataEpoch(epoch)) return;
        const responseId = `shiying:${postData.operationId}:${response.actionIdentifier}`;
        if (current.handledNotificationResponseIdsRef.current.has(responseId)) return;
        current.handledNotificationResponseIdsRef.current.add(responseId);
        void dismissShiyingBatchNotification(postData.batchId).catch(() => undefined);
        current.onOpenShiyingNotification?.({ requestId: responseId, batchId: postData.batchId, dataEpoch: epoch });
        return;
      }
      if (isPostNotificationPayload(postData)) {
        const responseId = `post:${postData.requestId}:${response.actionIdentifier}`;
        if (current.handledNotificationResponseIdsRef.current.has(responseId)) return;
        current.handledNotificationResponseIdsRef.current.add(responseId);
        void openPostNotification(postData).then(opened => {
          if (!opened || stopped) return;
          requestCorrespondenceTab('posts');
          optionsRef.current.navigate('letter');
        }).catch(() => { current.handledNotificationResponseIdsRef.current.delete(responseId); });
        return;
      }
      const identifier = response.notification.request.identifier;
      if (current.handledNotificationResponseIdsRef.current.has(identifier)) return;
      current.handledNotificationResponseIdsRef.current.add(identifier);
      const data = response.notification.request.content.data;
      if (typeof data?.companionEventId === 'string') {
        receiveScheduleCompanionNotification(true);
      } else if (current.isChatMessageNotificationData(data)) {
        current.openChatFromMessageSurface();
      } else if (current.isReminderNotificationData(data)) {
        void receiveProtected(true, true);
      }
    };
    const notificationResponseSubscription =
      Notifications.addNotificationResponseReceivedListener(handleNotificationResponse);
    const coldNotificationEpoch = captureBackupRestoreDataEpoch();
    void Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (!response) return;
        if ((isShiyingNotificationDomain(response.notification.request.content.data)
          || isPostNotificationPayload(response.notification.request.content.data))
          && (stopped || !canCommitBackupRestoreDataEpoch(coldNotificationEpoch))) return;
        handleNotificationResponse(response);
        void Notifications.clearLastNotificationResponseAsync().catch(() => undefined);
      })
      .catch(() => undefined);

    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') shiyingAutomatic.wake();
      else shiyingAutomatic.pause();
      if (state === 'active') shiyingReviews.wake();
      else shiyingReviews.pause();
      if (state === 'active') void foregroundTask.run();
      else void runBackupProtectedTask(() => syncNearbyWorldBackgroundTask()).catch(() => undefined);
    });

    return () => {
      stopShiyingRecordRuntime();
      stopShiyingNotifications();
      shiyingImages.stop();
      shiyingAutomatic.stop();
      shiyingReviews.stop();
      stopped = true;
      startupInteraction.cancel?.();
      if (deferredAiTimer) clearTimeout(deferredAiTimer);
      if (musicAlarmTimer) clearTimeout(musicAlarmTimer);
      if (chatReminderTimer) clearTimeout(chatReminderTimer);
      clearInterval(incomingInterval);
      clearInterval(phoneActivityInterval);
      clearInterval(lifeInterval);
      stopAlarmObserver();
      stopScheduleObserver();
      stopLetterObserver();
      stopPostObserver();
      notificationResponseSubscription.remove();
      appStateSubscription.remove();
    };
  }, [options.enabled]);
}
