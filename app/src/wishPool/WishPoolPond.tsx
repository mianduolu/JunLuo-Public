import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, StyleSheet, View } from 'react-native';
import { AppText as Text } from '../components/AppText';

export type WishPondMotion = 'idle' | 'cast' | 'draw';

// No storage or success inference here. Live cast motion may only be triggered after a saved confirmation.
export function WishPoolPond({ motion = 'idle', onSettled }: { motion?: WishPondMotion; onSettled?: () => void }) {
  const phase = useRef(new Animated.Value(0)).current;
  const [settled, setSettled] = useState(false);
  const settledCallback = useRef(onSettled);
  settledCallback.current = onSettled;
  useEffect(() => {
    let active = true;
    let animation: Animated.CompositeAnimation | undefined;
    phase.setValue(0);
    setSettled(false);
    if (motion !== 'idle') {
      void AccessibilityInfo.isReduceMotionEnabled().catch(() => true).then((reduce) => {
        if (!active) return;
        animation = Animated.timing(phase, { toValue: 1, duration: reduce ? 0 : 1100, useNativeDriver: true });
        animation.start(({ finished }) => { if (active && finished) { setSettled(true); settledCallback.current?.(); } });
      });
    }
    return () => { active = false; animation?.stop(); };
  }, [motion, phase]);
  return <View style={styles.scene} accessible accessibilityLabel={motion === 'idle' ? '许愿池池面' : '许愿币动画预览'}>
    <View style={styles.bank} />
    <View style={styles.water}><View style={styles.waterLine} /><View style={styles.light} /></View>
    <View style={[styles.leaf, { left: '17%', top: 134 }]} /><View style={[styles.leaf, { right: '14%', top: 100 }]} />
    {motion === 'idle' ? <Text style={styles.star}>✧</Text> : <>
      <Animated.View style={[styles.coin, { opacity: motion === 'cast' ? phase.interpolate({ inputRange: [0, 0.7, 1], outputRange: [1, 1, 0] }) : phase,
        transform: [{ translateY: phase.interpolate({ inputRange: [0, 1], outputRange: motion === 'cast' ? [-65, 34] : [48, -20] }) }] }]}>
        <Text style={styles.coinMark}>✦</Text>
      </Animated.View>
      {motion === 'cast' ? <Animated.View style={[styles.ripple, {
        opacity: phase.interpolate({ inputRange: [0, 0.65, 0.8, 1], outputRange: [0, 0, 0.8, 0] }),
        transform: [{ scale: phase.interpolate({ inputRange: [0, 0.65, 1], outputRange: [0.2, 0.2, 2.5] }) }],
      }]} /> : null}
    </>}
    {motion === 'draw' && settled ? <Text testID="wish-draw-reveal" style={styles.reveal}>✦</Text> : null}
  </View>;
}

const styles = StyleSheet.create({
  scene: { height: 220, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  bank: { position: 'absolute', top: 49, width: '94%', height: 148, backgroundColor: '#DCE8DF', borderRadius: 140, transform: [{ rotate: '-7deg' }] },
  water: { position: 'absolute', top: 47, width: '91%', height: 134, backgroundColor: '#C7E8EA', borderRadius: 140, borderWidth: 5, borderColor: '#F8FCF5', transform: [{ rotate: '-7deg' }], overflow: 'hidden' },
  waterLine: { position: 'absolute', top: 13, left: '9%', width: '81%', height: 96, borderWidth: 1, borderColor: '#EDF9F5', borderRadius: 100 },
  light: { position: 'absolute', top: 25, left: '13%', height: 7, width: '32%', backgroundColor: '#ECF9F3', borderRadius: 12 },
  leaf: { position: 'absolute', width: 29, height: 19, borderRadius: 18, borderTopRightRadius: 2, backgroundColor: '#8DBEB0', transform: [{ rotate: '18deg' }] },
  star: { fontSize: 34, color: '#FFFDF4', marginTop: 7 },
  coin: { position: 'absolute', left: '50%', marginLeft: -20, top: 72, width: 40, height: 40, borderRadius: 22, borderWidth: 3, borderColor: '#E5B76B', backgroundColor: '#FFE7A5', alignItems: 'center', justifyContent: 'center' },
  coinMark: { fontSize: 24, color: '#9E6C30' },
  ripple: { position: 'absolute', top: 126, width: 52, height: 18, borderRadius: 30, borderWidth: 2, borderColor: '#FFFFFF' },
  reveal: { position: 'absolute', top: 22, right: '33%', fontSize: 26, color: '#C39550' },
});
