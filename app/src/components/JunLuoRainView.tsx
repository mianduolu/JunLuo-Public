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
import { useMemo } from 'react';

export type JunLuoRainParticle = {
  drift: number;
  opacity: number;
  phase: number;
  size: number;
  speed: number;
  x: number;
  y: number;
};

export type JunLuoRainRendererState = {
  generation: number;
  reason?: 'api_unsupported' | 'invalid_spec';
  state: 'ready' | 'content_ready' | 'unavailable';
};

export type JunLuoPrecipitationKind = 'hail' | 'rain' | 'snow';

type Props = {
  active: boolean;
  animated: boolean;
  diagnosticTimeMs: number;
  diagnosticsEnabled: boolean;
  enabled: boolean;
  effectKind: JunLuoPrecipitationKind;
  exitingAtMs: number;
  generation: number;
  layerOpacity: number;
  logicalHeight: number;
  logicalWidth: number;
  onRendererStateChange(event: JunLuoRainRendererState): void;
  particles: JunLuoRainParticle[];
  startedAtMs: number;
  style?: StyleProp<ViewStyle>;
  transitionDurationMs: number;
};

type NativeProps = Omit<Props, 'onRendererStateChange' | 'particles'> & {
  onRendererStateChange(event: NativeSyntheticEvent<JunLuoRainRendererState>): void;
  particles: number[];
};

function resolveNativeRainView() {
  if (Platform.OS !== 'android') return undefined;

  try {
    if (!UIManager.getViewManagerConfig('JunLuoRainView')) return undefined;
    return requireNativeComponent<NativeProps>('JunLuoRainView');
  } catch {
    return undefined;
  }
}

const NativeJunLuoRainView = resolveNativeRainView();

export function JunLuoRainView({ onRendererStateChange, particles, style, ...props }: Props) {
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

  if (!NativeJunLuoRainView) return null;

  return (
    <View pointerEvents="none" style={style}>
      <NativeJunLuoRainView
        {...props}
        onRendererStateChange={(event) => onRendererStateChange(event.nativeEvent)}
        particles={flattenedParticles}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}
