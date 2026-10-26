import { useEffect, useRef } from 'react';
import { Image, Pressable, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { AppText as Text } from '../components/AppText';
import { styles } from '../screens/ChatScreen.styles';

type PokeAvatarProps = {
  bubble?: string;
  doubleTapDisabled?: boolean;
  imageStyle: object;
  onDoubleTap: () => void;
  source: number;
};

const DOUBLE_TAP_WINDOW_MS = 240;

export function PokeAvatar({
  bubble,
  doubleTapDisabled,
  imageStyle,
  onDoubleTap,
  source,
}: PokeAvatarProps) {
  const lastTapAtRef = useRef(0);
  const singleTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rotation = useSharedValue(0);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  useEffect(() => () => {
    if (singleTapTimerRef.current) clearTimeout(singleTapTimerRef.current);
  }, []);

  const handlePress = () => {
    const now = Date.now();
    if (!lastTapAtRef.current || now - lastTapAtRef.current > DOUBLE_TAP_WINDOW_MS) {
      lastTapAtRef.current = now;
      if (singleTapTimerRef.current) clearTimeout(singleTapTimerRef.current);
      singleTapTimerRef.current = setTimeout(() => {
        lastTapAtRef.current = 0;
        singleTapTimerRef.current = null;
      }, DOUBLE_TAP_WINDOW_MS);
      return;
    }
    lastTapAtRef.current = 0;
    if (singleTapTimerRef.current) {
      clearTimeout(singleTapTimerRef.current);
      singleTapTimerRef.current = null;
    }
    if (doubleTapDisabled) {
      return;
    }
    rotation.value = withSequence(
      withTiming(-7, { duration: 65 }),
      withTiming(7, { duration: 90 }),
      withTiming(-4, { duration: 75 }),
      withTiming(4, { duration: 75 }),
      withTiming(0, { duration: 65 }),
    );
    onDoubleTap();
  };

  return (
    <View style={styles.pokeAvatarWrap}>
      {bubble ? (
        <Animated.View entering={FadeIn.duration(100)} exiting={FadeOut.duration(120)} style={styles.pokeBubble}>
          <Text adjustsFontSizeToFit minimumFontScale={0.72} numberOfLines={1} style={styles.pokeBubbleText}>
            {bubble}
          </Text>
        </Animated.View>
      ) : null}
      <Pressable
        accessibilityHint="双击戳一戳"
        accessibilityLabel="白云小姐头像"
        accessibilityRole="button"
        android_ripple={{ borderless: true, color: 'rgba(178,217,255,0.32)' }}
        hitSlop={6}
        onPress={handlePress}
        style={({ pressed }) => ({
          opacity: pressed ? 0.7 : 1,
          transform: [{ scale: pressed ? 0.96 : 1 }],
        })}
      >
        <Animated.View style={animatedStyle}>
          <Image resizeMode="contain" source={source} style={imageStyle} />
        </Animated.View>
      </Pressable>
    </View>
  );
}
