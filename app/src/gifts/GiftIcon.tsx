import Svg, { Path, Rect } from 'react-native-svg';

export function GiftIcon({ size = 26, color = '#697184' }: { size?: number; color?: string }) {
  return <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round">
    <Rect x={3} y={8} width={18} height={4} rx={1} />
    <Path d="M5 12v8h14v-8M12 8v12M12 8H7.5A2.5 2.5 0 1 1 10 5.5L12 8Zm0 0h4.5A2.5 2.5 0 1 0 14 5.5L12 8Z" />
  </Svg>;
}
