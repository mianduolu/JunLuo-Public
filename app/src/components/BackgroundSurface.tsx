import { PropsWithChildren } from 'react';
import { ImageBackground, StyleSheet } from 'react-native';

import type { BackgroundSettings } from '../backgrounds/BackgroundPreferences';
import type { WeatherKind } from '../types/weather';
import type { SkyTheme } from '../utils/sky';
import { SkyBackground } from './SkyBackground';

type Props = PropsWithChildren<{
  active?: boolean;
  settings: BackgroundSettings;
  skyTheme: SkyTheme;
  weatherKind?: WeatherKind;
}>;

export function BackgroundSurface({
  active = true,
  children,
  settings,
  skyTheme,
  weatherKind,
}: Props) {
  if (settings.mode === 'image' && settings.imageUri) {
    return (
      <ImageBackground
        source={{ uri: settings.imageUri }}
        resizeMode={settings.imageFit}
        style={styles.root}
      >
        {children}
      </ImageBackground>
    );
  }

  return (
    <SkyBackground active={active} theme={skyTheme} weatherKind={weatherKind}>
      {children}
    </SkyBackground>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
