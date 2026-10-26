import {
  scheduleSemanticStorageBridge as AsyncStorage,
} from '../sync/syncScheduleSemanticStorageBridge';

const PENDING_SCHEDULE_REQUEST_KEY = 'junluo.schedule.pendingRequest';

export async function savePendingScheduleRequest(request: string) {
  await AsyncStorage.setItem(PENDING_SCHEDULE_REQUEST_KEY, request.trim());
}

export async function takePendingScheduleRequest() {
  const request = await AsyncStorage.getItem(PENDING_SCHEDULE_REQUEST_KEY);
  if (request) await AsyncStorage.removeItem(PENDING_SCHEDULE_REQUEST_KEY);
  return request?.trim() || null;
}
