import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  appearanceWeatherEntityId,
  assertAppearanceWeatherRecord,
  type AppearanceWeatherAnimationPolicy,
  type AppearanceWeatherObservation,
  type AppearanceWeatherStyle,
} from './syncAppearanceWeather';
import type {
  AppearanceWeatherBusinessPort,
} from './syncAppearanceWeatherApply';
import {
  APPEARANCE_WEATHER_ANIMATION_KEY,
  APPEARANCE_WEATHER_OBSERVATION_KEY,
  APPEARANCE_WEATHER_STYLE_KEY,
  parseAppearanceWeatherObservation,
  serializeAppearanceWeatherAnimationEnabled,
  serializeAppearanceWeatherObservation,
} from './syncAppearanceWeatherStorageDerivation';

type AppearanceWeatherStoragePort = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

let applyQueue = Promise.resolve();

function enqueueApply<T>(callback: () => Promise<T>) {
  const current = applyQueue.catch(() => undefined).then(callback);
  applyQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

function shouldReplaceObservation(
  current: AppearanceWeatherObservation | undefined,
  incoming: AppearanceWeatherObservation,
) {
  if (!current) return true;
  if (incoming.observedAt !== current.observedAt) {
    return incoming.observedAt > current.observedAt;
  }
  if (incoming.fetchedAt !== current.fetchedAt) {
    return incoming.fetchedAt > current.fetchedAt;
  }
  return incoming.observationId > current.observationId;
}

export function createAppearanceWeatherBusinessPort(input: {
  storage: AppearanceWeatherStoragePort;
  now?: () => number;
}): AppearanceWeatherBusinessPort {
  const now = input.now ?? Date.now;
  return {
    upsert: (change) => enqueueApply(async () => {
      assertAppearanceWeatherRecord(change.kind, change.value);
      if (change.kind === 'weather-animation-policy') {
        const value =
          change.value as AppearanceWeatherAnimationPolicy;
        await input.storage.setItem(
          APPEARANCE_WEATHER_ANIMATION_KEY,
          serializeAppearanceWeatherAnimationEnabled(value.enabled),
        );
        return;
      }
      if (change.kind === 'weather-style') {
        await input.storage.setItem(
          APPEARANCE_WEATHER_STYLE_KEY,
          JSON.stringify(change.value as AppearanceWeatherStyle),
        );
        return;
      }
      const value = change.value as AppearanceWeatherObservation;
      if (value.expiresAt <= now()) return;
      const current = parseAppearanceWeatherObservation(
        await input.storage.getItem(
          APPEARANCE_WEATHER_OBSERVATION_KEY,
        ),
      );
      if (!shouldReplaceObservation(current, value)) return;
      await input.storage.setItem(
        APPEARANCE_WEATHER_OBSERVATION_KEY,
        serializeAppearanceWeatherObservation(value),
      );
    }),
    tombstone: (change) => enqueueApply(async () => {
      if (
        change.kind === 'weather-animation-policy'
        && change.entityId === appearanceWeatherEntityId(
          'weather-animation-policy',
          'global',
        )
      ) {
        await input.storage.removeItem(
          APPEARANCE_WEATHER_ANIMATION_KEY,
        );
        return;
      }
      if (
        change.kind === 'weather-style'
        && change.entityId === appearanceWeatherEntityId(
          'weather-style',
          'junluo-procedural-weather',
        )
      ) {
        await input.storage.removeItem(APPEARANCE_WEATHER_STYLE_KEY);
        return;
      }
      if (change.kind !== 'weather-observation') return;
      const current = parseAppearanceWeatherObservation(
        await input.storage.getItem(
          APPEARANCE_WEATHER_OBSERVATION_KEY,
        ),
      );
      if (
        current
        && change.entityId === appearanceWeatherEntityId(
          'weather-observation',
          current.observationId,
        )
      ) {
        await input.storage.removeItem(
          APPEARANCE_WEATHER_OBSERVATION_KEY,
        );
      }
    }),
  };
}

export const appearanceWeatherAsyncStorageBusinessPort =
  createAppearanceWeatherBusinessPort({
    storage: RawAsyncStorage,
  });
