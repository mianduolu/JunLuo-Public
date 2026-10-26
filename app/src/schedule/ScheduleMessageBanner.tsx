import { Image, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { homeImages } from '../assets/homeImages';
import { AppText as Text } from '../components/AppText';
import { scheduleReminderPersonaLabel } from './scheduleReminderPersona';

export type ScheduleMessageBannerItem = {
  message: SubjectiveMessage;
};

export function ScheduleMessageBanner({ item, onClose, onOpen }: {
  item: ScheduleMessageBannerItem;
  onClose: () => void;
  onOpen: () => void;
}) {
  const insets = useSafeAreaInsets();
  const label = item.message.source === 'schedule-reminder' || item.message.source === 'schedule-companion'
    ? scheduleReminderPersonaLabel(item.message.scheduleReminderPersona)
    : '白云小姐';
  return (
    <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, styles.overlay]}>
      <Pressable
        accessibilityLabel="打开白云小姐的消息"
        onPress={onOpen}
        style={[styles.banner, { top: Math.max(insets.top + 8, 20) }]}
      >
        <Image resizeMode="contain" source={homeImages.youPortraitNeutral} style={styles.avatar} />
        <View style={styles.copy}>
          <Text style={styles.name}>{label}</Text>
          <Text numberOfLines={3} style={styles.message}>{item.message.content}</Text>
        </View>
        <Pressable accessibilityLabel="关闭提醒" hitSlop={10} onPress={(event) => { event.stopPropagation(); onClose(); }} style={styles.close}>
          <Text style={styles.closeText}>×</Text>
        </Pressable>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    elevation: 1000,
    zIndex: 1000,
  },
  banner: {
    alignItems: 'center',
    backgroundColor: 'rgba(240,247,255,0.98)',
    borderColor: '#C9DEF2',
    borderRadius: 14,
    borderWidth: 1,
    elevation: 10,
    flexDirection: 'row',
    gap: 10,
    left: 16,
    minHeight: 76,
    paddingHorizontal: 12,
    paddingVertical: 10,
    position: 'absolute',
    right: 16,
    shadowColor: '#435E78',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    zIndex: 1000,
  },
  avatar: { height: 48, width: 48 },
  copy: { flex: 1, gap: 3 },
  name: { color: '#38536D', fontSize: 13, fontWeight: '500' },
  message: { color: '#2F3D4B', fontSize: 14, fontWeight: '400', lineHeight: 20 },
  close: { alignItems: 'center', height: 28, justifyContent: 'center', width: 28 },
  closeText: { color: '#748596', fontSize: 24, fontWeight: '400', lineHeight: 26 },
});
