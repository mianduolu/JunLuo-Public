import { PropsWithChildren, createContext, useContext, useEffect, useMemo, useState } from 'react';

import {
  appearanceWeatherStorageBridge as AsyncStorage,
} from '../sync/syncAppearanceWeatherStorageBridge';
const WEATHER_ANIMATION_SETTINGS_KEY = 'junluo.weatherAnimationEnabled';

type WeatherAnimationPreferencesValue = {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
};

const WeatherAnimationPreferencesContext = createContext<WeatherAnimationPreferencesValue | undefined>(undefined);

export function WeatherAnimationPreferencesProvider({ children }: PropsWithChildren) {
  const [enabled, setEnabled] = useState(true);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(WEATHER_ANIMATION_SETTINGS_KEY).then((storedValue) => {
      if (storedValue !== null) {
        setEnabled(storedValue !== 'false');
      }

      setIsReady(true);
    });
  }, []);

  useEffect(() => {
    if (isReady) {
      void AsyncStorage.setItem(WEATHER_ANIMATION_SETTINGS_KEY, String(enabled));
    }
  }, [enabled, isReady]);

  const value = useMemo(() => ({ enabled, setEnabled }), [enabled]);

  return (
    <WeatherAnimationPreferencesContext.Provider value={value}>
      {children}
    </WeatherAnimationPreferencesContext.Provider>
  );
}

export function useWeatherAnimationPreferences() {
  const context = useContext(WeatherAnimationPreferencesContext);

  if (!context) {
    throw new Error('useWeatherAnimationPreferences must be used inside WeatherAnimationPreferencesProvider.');
  }

  return context;
}
