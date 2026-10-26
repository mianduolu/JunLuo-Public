import { Pressable, StyleSheet, View } from 'react-native';

import { AppText as Text } from './AppText';
import { colors } from '../theme/colors';
import type { Navigate, ScreenName } from '../types/navigation';

type Item = {
  key: ScreenName;
  label: string;
};

const items: Item[] = [
  { key: 'home', label: '首页' },
  { key: 'chat', label: '聊天' },
  { key: 'settings', label: '设置' },
];

type Props = {
  current: ScreenName;
  navigate: Navigate;
};

export function BottomNav({ current, navigate }: Props) {
  return (
    <View style={styles.wrap}>
      {items.map((item) => {
        const active = item.key === current;

        return (
          <Pressable
            key={item.key}
            onPress={() => navigate(item.key)}
            style={[styles.item, active ? styles.itemActive : null]}
          >
            <Text style={[styles.label, active ? styles.labelActive : null]}>{item.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 14,
    height: 54,
    borderRadius: 27,
    backgroundColor: colors.cardStrong,
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    padding: 6,
  },
  item: {
    flex: 1,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemActive: {
    backgroundColor: colors.primary,
  },
  label: {
    color: colors.muted,
    fontSize: 14,
    fontWeight: '600',
  },
  labelActive: {
    color: '#FFFFFF',
  },
});
