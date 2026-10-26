import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import type { WeatherState } from '../types/weather';
import { fetchCurrentWeather, getInitialWeather, loadStoredWeather } from '../utils/weather';

export function useWeather(active = true) {
  const [weather, setWeather] = useState<WeatherState>(getInitialWeather);

  useEffect(() => {
    if (!active) return;
    let isMounted = true;
    let currentAppState = AppState.currentState;

    const updateWeather = async (includeStoredWeather = false) => {
      const storedWeather = includeStoredWeather
        ? await loadStoredWeather()
        : undefined;
      if (!isMounted) return;

      if (storedWeather) {
        setWeather(storedWeather);
      }

      try {
        const nextWeather = await fetchCurrentWeather();
        if (!isMounted) return;
        if (nextWeather.error) {
          if (includeStoredWeather && !storedWeather) {
            setWeather(nextWeather);
          }
          return;
        }

        setWeather(nextWeather);
      } catch (error: unknown) {
        if (!isMounted || !includeStoredWeather || storedWeather) return;

        console.warn('weather fetch failed', error);
        setWeather({
          kind: 'unknown',
          label: '没找到天气T T',
          isLoading: false,
          error: 'fetch-failed',
        });
      }
    };

    void updateWeather(true);

    const appStateSubscription = AppState.addEventListener('change', (nextAppState) => {
      const returnedToForeground =
        /inactive|background/.test(currentAppState)
        && nextAppState === 'active';
      currentAppState = nextAppState;
      if (returnedToForeground) {
        void updateWeather();
      }
    });

    return () => {
      isMounted = false;
      appStateSubscription.remove();
    };
  }, [active]);

  return weather;
}
