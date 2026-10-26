import { useMemo } from 'react';
import {
  Platform,
  requireNativeComponent,
  StyleSheet,
  UIManager,
  View,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import type { JunLuoRainParticle, JunLuoRainRendererState } from './JunLuoRainView';

type Props = {
  active: boolean;
  animated: boolean;
  diagnosticTimeMs: number;
  diagnosticsEnabled: boolean;
  effectKind: 'dust' | 'fog';
  enabled: boolean;
  exitingAtMs: number;
  generation: number;
  layerOpacity: number;
  logicalHeight: number;
  logicalWidth: number;
  onRendererStateChange(event: JunLuoRainRendererState): void;
  opacityBoost: number;
  particles: JunLuoRainParticle[];
  startedAtMs: number;
  style?: StyleProp<ViewStyle>;
  transitionDurationMs: number;
};

type NativeProps = Omit<Props, 'onRendererStateChange' | 'particles'> & {
  onRendererStateChange(event: NativeSyntheticEvent<JunLuoRainRendererState>): void;
  particles: number[];
};

function resolveNativeFogView() {
  if (Platform.OS !== 'android') return undefined;

  try {
    if (!UIManager.getViewManagerConfig('JunLuoFogView')) return undefined;
    return requireNativeComponent<NativeProps>('JunLuoFogView');
  } catch {
    return undefined;
  }
}

const NativeJunLuoFogView = resolveNativeFogView();

export function JunLuoFogView({ onRendererStateChange, particles, style, ...props }: Props) {
  const flattenedParticles = useMemo(
    () => particles.flatMap((particle) => [
      particle.x,
      particle.y,
      particle.size,
      particle.speed,
      particle.opacity,
      particle.drift,
      particle.phase,
    ]),
    [particles],
  );

  if (!NativeJunLuoFogView) return null;

  return (
    <View pointerEvents="none" style={style}>
      <NativeJunLuoFogView
        {...props}
        onRendererStateChange={(event) => onRendererStateChange(event.nativeEvent)}
        particles={flattenedParticles}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}
