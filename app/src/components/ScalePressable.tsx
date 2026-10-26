import { PropsWithChildren, useRef } from 'react';
import { Animated, Pressable, PressableProps, StyleProp, ViewStyle } from 'react-native';

type Props = PropsWithChildren<
  PressableProps & {
    style?: StyleProp<ViewStyle>;
    pressedScale?: number;
  }
>;

export function ScalePressable({ children, style, pressedScale = 0.94, onPressIn, onPressOut, ...props }: Props) {
  const scale = useRef(new Animated.Value(1)).current;

  function animate(toValue: number) {
    Animated.spring(scale, {
      toValue,
      speed: 28,
      bounciness: 7,
      useNativeDriver: true,
    }).start();
  }

  return (
    <Pressable
      {...props}
      onPressIn={(event) => {
        animate(pressedScale);
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        animate(1);
        onPressOut?.(event);
      }}
    >
      <Animated.View style={[style, { transform: [{ scale }] }]}>{children}</Animated.View>
    </Pressable>
  );
}
