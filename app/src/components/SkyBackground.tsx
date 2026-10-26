import { Children, PropsWithChildren } from 'react';
import { StyleSheet, View } from 'react-native';

import { WeatherOverlay } from './WeatherOverlay';
import type { WeatherKind } from '../types/weather';
import type { SkyTheme } from '../utils/sky';
import { getCurrentSkyTheme } from '../utils/sky';

type Props = PropsWithChildren<{
  active?: boolean;
  theme?: SkyTheme;
  weatherKind?: WeatherKind;
}>;

export function SkyBackground({
  active = true,
  children,
  theme = getCurrentSkyTheme(),
  weatherKind = 'unknown',
}: Props) {
  const safeChildren = Children.toArray(children).filter(
    (child) => typeof child !== 'string' && typeof child !== 'number',
  );

  return (
    <View style={styles.root}>
      <WeatherOverlay active={active} kind={weatherKind} theme={theme} />
      {safeChildren}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
