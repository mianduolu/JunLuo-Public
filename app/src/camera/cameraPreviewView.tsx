import { Platform, requireNativeComponent, type NativeSyntheticEvent, type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native';

export type CameraPreviewPhase = 'off' | 'starting' | 'streaming' | 'switching' | 'suspended' | 'error';

export type CameraPreviewEvent = {
  previewId: string;
  sessionId?: string;
  generation: number;
  phase: CameraPreviewPhase;
  facing?: 'front' | 'back';
  sourceKind?: 'android_front' | 'android_back';
  previewWidth?: number;
  previewHeight?: number;
  requestedPreviewFps?: [15, 15];
  failureCode?: string;
  reasonCode?: string;
};

type Props = {
  previewId: string;
  sessionId?: string;
  requestedFacing: 'front' | 'back';
  active: boolean;
  generation: number;
  onPreviewStateChanged(event: CameraPreviewEvent): void;
  style?: StyleProp<ViewStyle>;
};

type NativeProps = Omit<Props, 'onPreviewStateChanged'> & {
  onPreviewStateChanged(event: NativeSyntheticEvent<CameraPreviewEvent>): void;
};

const NativeJunLuoCameraPreview = Platform.OS === 'android'
  ? requireNativeComponent<NativeProps>('JunLuoCameraPreview')
  : undefined;

export function JunLuoCameraPreview({ onPreviewStateChanged, ...props }: Props) {
  if (!NativeJunLuoCameraPreview) return <View style={props.style} />;
  return (
    <View pointerEvents="none" style={props.style}>
      <NativeJunLuoCameraPreview
        {...props}
        style={StyleSheet.absoluteFill}
        onPreviewStateChanged={(event) => onPreviewStateChanged(event.nativeEvent)}
      />
    </View>
  );
}
