import { NativeModules, Platform } from 'react-native';

export type ScheduleNativeWakeTask = {
  eventId: string;
  scheduledAt: number;
  prepareAheadMs?: number;
};
export type ScheduleNativeWakePayload = ScheduleNativeWakeTask & {
  phase: 'prepare' | 'deliver' | 'deadline';
};

type ScheduleReminderModule = {
  replaceTasks(tasks: ScheduleNativeWakeTask[]): Promise<boolean>;
  cancelTask(eventId: string): Promise<void>;
};

function nativeModule(): ScheduleReminderModule | undefined {
  return Platform.OS === 'android' ? NativeModules.JunLuoScheduleReminder : undefined;
}

export async function replaceScheduleNativeWakeTasks(tasks: ScheduleNativeWakeTask[]): Promise<boolean> {
  const module = nativeModule();
  return module ? module.replaceTasks(tasks) : false;
}

export async function cancelScheduleNativeWakeTask(eventId: string): Promise<void> {
  await nativeModule()?.cancelTask(eventId);
}
