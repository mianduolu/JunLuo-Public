import { NativeModules, Platform } from 'react-native';

export type SleepNativeWakeTask = {
  id: string;
  at: number;
  nightKey: string;
  phase: 'prepare' | 'prepare_retry' | 'sleep' | 'wake' | 'sleep_status' | 'unified_contact' | 'reading' | 'day_plan' | 'activity_start';
};

type SleepScheduleModule = {
  replaceTasks(tasks: SleepNativeWakeTask[]): Promise<boolean>;
};

export async function replaceSleepNativeWakeTasks(tasks: SleepNativeWakeTask[]): Promise<boolean> {
  const module: SleepScheduleModule | undefined = Platform.OS === 'android'
    ? NativeModules.JunLuoSleepSchedule : undefined;
  return module ? module.replaceTasks(tasks) : false;
}
