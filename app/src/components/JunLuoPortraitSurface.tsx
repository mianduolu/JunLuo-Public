import {
  Image,
  Platform,
  StyleSheet,
  View,
  requireNativeComponent,
  type ImageSourcePropType,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

type Props = {
  active?: boolean;
  source: ImageSourcePropType;
  style?: StyleProp<ViewStyle>;
};

type NativeProps = {
  active?: boolean;
  sourceName?: string;
  style?: StyleProp<ViewStyle>;
};

const NativePortraitSurface = Platform.OS === 'android'
  ? requireNativeComponent<NativeProps>('JunLuoPortraitSurface')
  : undefined;

export function JunLuoPortraitSurface({ active = true, source, style }: Props) {
  const sourceName = Image.resolveAssetSource(source)?.uri;

  if (!NativePortraitSurface || !sourceName) {
    return (
      <View pointerEvents="none" style={style}>
        <Image source={source} resizeMode="contain" style={StyleSheet.absoluteFill} />
      </View>
    );
  }

  return (
    <View pointerEvents="none" style={style}>
      <NativePortraitSurface active={active} sourceName={sourceName} style={StyleSheet.absoluteFill} />
    </View>
  );
}
