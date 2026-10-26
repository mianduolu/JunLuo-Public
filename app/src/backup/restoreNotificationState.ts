export type PendingNotificationProjectionHealReport = {
  agentTasksScheduled: number;
  alarmsScheduled: number;
  lettersScheduled: number;
  nativeStrongAlarmsRebound: boolean;
  permissionGranted: boolean;
  scheduleSynced: boolean;
};

export type PendingNotificationProjectionHealOps = {
  hasNotificationPermission: () => Promise<boolean>;
  initializeNotificationChannels: () => Promise<void>;
  syncScheduleNotifications: () => Promise<boolean>;
  rebindLetterNotifications: () => Promise<number>;
  rebindAlarmNotifications: () => Promise<number>;
  rebindAgentTaskNotifications: () => Promise<number>;
  rebindNativeStrongAlarms?: () => Promise<boolean | void>;
};

export type RestoreNotificationCompensationReport = PendingNotificationProjectionHealReport & {
  nativeStrongAlarmsReset: boolean;
};

export type RestoreNotificationStateOps = PendingNotificationProjectionHealOps & {
  cancelAllScheduledNotifications: () => Promise<void>;
  dismissAllPresentedNotifications: () => Promise<void>;
  clearLastNotificationResponse: () => Promise<void>;
  resetNativeStrongAlarms?: () => Promise<boolean | void>;
  resetScheduleOccurrenceNotificationBindings: () => Promise<unknown>;
  resetScheduleCompanionNotificationBindings: () => Promise<unknown>;
  resetTodoReminderNotificationBindings: () => Promise<unknown>;
  resetLetterNotificationBindings: () => Promise<unknown>;
  resetAlarmNotificationBindings: () => Promise<unknown>;
  resetAgentTaskNotificationBindings: () => Promise<unknown>;
  resetShiyingNotifications?: () => Promise<void>;
};

export async function runPendingNotificationProjectionHeal(
  ops: PendingNotificationProjectionHealOps,
): Promise<PendingNotificationProjectionHealReport> {
  const permissionGranted = await ops.hasNotificationPermission();
  if (!permissionGranted) {
    return {
      agentTasksScheduled: 0,
      alarmsScheduled: 0,
      lettersScheduled: 0,
      nativeStrongAlarmsRebound: false,
      permissionGranted: false,
      scheduleSynced: false,
    };
  }

  await ops.initializeNotificationChannels();
  const scheduleSynced = await ops.syncScheduleNotifications();
  const lettersScheduled = await ops.rebindLetterNotifications();
  const alarmsScheduled = await ops.rebindAlarmNotifications();
  const agentTasksScheduled = await ops.rebindAgentTaskNotifications();
  const nativeRebindResult = await ops.rebindNativeStrongAlarms?.();
  const nativeStrongAlarmsRebound = !!ops.rebindNativeStrongAlarms && nativeRebindResult !== false;

  return {
    agentTasksScheduled,
    alarmsScheduled,
    lettersScheduled,
    nativeStrongAlarmsRebound,
    permissionGranted: true,
    scheduleSynced,
  };
}

export async function runRestoreNotificationCompensation(
  ops: RestoreNotificationStateOps,
): Promise<RestoreNotificationCompensationReport> {
  await ops.cancelAllScheduledNotifications();
  await ops.dismissAllPresentedNotifications();
  await ops.clearLastNotificationResponse();
  await ops.resetShiyingNotifications?.();

  const nativeResetResult = await ops.resetNativeStrongAlarms?.();
  const nativeStrongAlarmsReset = !!ops.resetNativeStrongAlarms && nativeResetResult !== false;

  await ops.resetScheduleOccurrenceNotificationBindings();
  await ops.resetScheduleCompanionNotificationBindings();
  await ops.resetTodoReminderNotificationBindings();
  await ops.resetLetterNotificationBindings();
  await ops.resetAlarmNotificationBindings();
  await ops.resetAgentTaskNotificationBindings();

  const healReport = await runPendingNotificationProjectionHeal(ops);

  return {
    ...healReport,
    nativeStrongAlarmsReset,
  };
}

export async function healPendingNotificationProjectionIfPermitted() {
  const { cancelRetiredPeriodNotifications } = await import('../period/periodStore');
  await cancelRetiredPeriodNotifications();
  const [
    ReactNative,
    scheduleNotifications,
    letterNotifications,
    alarmStore,
    agentTaskStore,
  ] = await Promise.all([
    import('react-native'),
    import('../schedule/scheduleNotifications'),
    import('../letters/letterNotifications'),
    import('../schedule/alarmStore'),
    import('../proactive/agentTaskStore'),
  ]);

  return runPendingNotificationProjectionHeal({
    hasNotificationPermission: () => scheduleNotifications.hasNotificationPermission(),
    initializeNotificationChannels: async () => {
      await scheduleNotifications.initializeScheduleNotifications();
      await letterNotifications.initializeLetterNotifications();
    },
    syncScheduleNotifications: () => scheduleNotifications.syncScheduleNotifications(),
    rebindLetterNotifications: () => letterNotifications.rebindRestoredLetterNotifications(),
    rebindAlarmNotifications: () => alarmStore.rebindRestoredAlarmNotifications(),
    rebindAgentTaskNotifications: () => agentTaskStore.rebindRestoredAgentTaskNotifications(),
    ...(ReactNative.Platform.OS === 'android'
      ? {
          rebindNativeStrongAlarms: () => alarmStore.rebindRestoredStrongAlarmNotifications(),
        }
      : {}),
  });
}

export async function reconcileRestoredNotificationState() {
  const { resetShiyingNotificationsAfterRestore } = await import('../shiying/shiyingNotifications');
  const { resetSleepOpportunitiesAfterRestore } = await import('../life/sleepPlanRuntime');
  await resetSleepOpportunitiesAfterRestore();
  const [
    Notifications,
    ReactNative,
    scheduleNotifications,
    scheduleStore,
    scheduleCompanionStore,
    todoStore,
    letterNotifications,
    alarmStore,
    agentTaskStore,
  ] = await Promise.all([
    import('expo-notifications'),
    import('react-native'),
    import('../schedule/scheduleNotifications'),
    import('../schedule/scheduleStore'),
    import('../schedule/scheduleCompanionStore'),
    import('../schedule/todoStore'),
    import('../letters/letterNotifications'),
    import('../schedule/alarmStore'),
    import('../proactive/agentTaskStore'),
  ]);

  return runRestoreNotificationCompensation({
    cancelAllScheduledNotifications: () => Notifications.cancelAllScheduledNotificationsAsync(),
    dismissAllPresentedNotifications: () => Notifications.dismissAllNotificationsAsync(),
    clearLastNotificationResponse: () => Notifications.clearLastNotificationResponseAsync(),
    resetShiyingNotifications: () => resetShiyingNotificationsAfterRestore(),
    resetScheduleOccurrenceNotificationBindings: () => scheduleStore.resetScheduleOccurrenceNotificationBindings(),
    resetScheduleCompanionNotificationBindings: () => scheduleCompanionStore.resetScheduleCompanionNotificationBindings(),
    resetTodoReminderNotificationBindings: () => todoStore.resetTodoReminderNotificationBindings(),
    resetLetterNotificationBindings: () => letterNotifications.resetLetterNotificationBindings(),
    resetAlarmNotificationBindings: () => alarmStore.resetAlarmNotificationBindings(),
    resetAgentTaskNotificationBindings: () => agentTaskStore.resetAgentTaskNotificationBindings(),
    hasNotificationPermission: () => scheduleNotifications.hasNotificationPermission(),
    initializeNotificationChannels: async () => {
      await scheduleNotifications.initializeScheduleNotifications();
      await letterNotifications.initializeLetterNotifications();
    },
    syncScheduleNotifications: () => scheduleNotifications.syncScheduleNotifications(),
    rebindLetterNotifications: () => letterNotifications.rebindRestoredLetterNotifications(),
    rebindAlarmNotifications: () => alarmStore.rebindRestoredAlarmNotifications(),
    rebindAgentTaskNotifications: () => agentTaskStore.rebindRestoredAgentTaskNotifications(),
    ...(ReactNative.Platform.OS === 'android'
      ? {
          resetNativeStrongAlarms: async () => {
            await alarmStore.resetRestoredStrongAlarmState();
            return true;
          },
          rebindNativeStrongAlarms: () => alarmStore.rebindRestoredStrongAlarmNotifications(),
        }
      : {}),
  });
}
