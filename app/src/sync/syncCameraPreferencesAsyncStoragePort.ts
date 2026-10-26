import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  assertCameraPreferenceFieldValue,
} from './syncCameraPreferences';
import type {
  CameraPreferencesBusinessPort,
} from './syncCameraPreferencesApply';
import {
  CAMERA_PERCEPTION_SETTINGS_KEY,
  normalizeCameraPerceptionSettingsValue,
  parseCameraPerceptionSettingsRaw,
} from './syncCameraPreferencesStorageDerivation';

let cameraPreferencesApplyQueue = Promise.resolve();

function enqueueCameraPreferencesApply<T>(
  callback: () => Promise<T>,
) {
  const current = cameraPreferencesApplyQueue
    .catch(() => undefined)
    .then(callback);
  cameraPreferencesApplyQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

async function upsertPreferenceField(
  input: Parameters<
    CameraPreferencesBusinessPort['upsertPreferenceField']
  >[0],
) {
  assertCameraPreferenceFieldValue(input.field, input.value);
  if (
    input.field === 'sessionAuthorization'
    || input.field === 'rawFrameRetention'
  ) {
    return;
  }
  const current = parseCameraPerceptionSettingsRaw(
    await RawAsyncStorage.getItem(CAMERA_PERCEPTION_SETTINGS_KEY),
  );
  const next = {
    ...current,
    quietHours: { ...current.quietHours },
  };
  if (input.field === 'intervalWindow') {
    const interval = input.value as {
      minimumIntervalMinutes: number;
      maximumIntervalMinutes: number;
    };
    next.minimumIntervalMinutes = interval.minimumIntervalMinutes;
    next.maximumIntervalMinutes = interval.maximumIntervalMinutes;
  } else if (input.field === 'quietHours') {
    next.quietHours = {
      ...(input.value as {
        enabled: boolean;
        startMinuteOfDay: number;
        endMinuteOfDay: number;
      }),
    };
  } else {
    next.preferredAndroidFacing = input.value as 'front' | 'back';
  }
  const normalized = normalizeCameraPerceptionSettingsValue(next);
  if (JSON.stringify(normalized) !== JSON.stringify(next)) {
    throw new Error(
      'camera.preferences 远端字段无法形成合法设置快照。',
    );
  }
  await RawAsyncStorage.setItem(
    CAMERA_PERCEPTION_SETTINGS_KEY,
    JSON.stringify(next),
  );
}

export const cameraPreferencesAsyncStorageBusinessPort:
CameraPreferencesBusinessPort = {
  upsertPreferenceField: (input) => enqueueCameraPreferencesApply(
    () => upsertPreferenceField(input),
  ),
};
