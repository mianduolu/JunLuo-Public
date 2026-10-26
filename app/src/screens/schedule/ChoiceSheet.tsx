import { memo } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';

import { AppText as Text } from '../../components/AppText';
import { colors } from '../../theme/colors';

export type ChoiceSheetOption = {
  caption?: string;
  color?: string;
  icon?: string;
  label: string;
  onSelect: () => void;
  selected?: boolean;
};

export type ChoiceSheetState = {
  options: ChoiceSheetOption[];
  prompt: string;
  title: string;
};

type Props = {
  onClose: () => void;
  sheet: ChoiceSheetState | null;
};

export const ChoiceSheet = memo(function ChoiceSheet({ onClose, sheet }: Props) {
  if (!sheet) return null;
  return (
    <Modal animationType="fade" transparent visible onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={onClose} />
        <View style={styles.panel}>
          <View style={styles.header}>
            <View>
              <Text style={styles.title}>{sheet.title}</Text>
              <Text style={styles.prompt}>{sheet.prompt}</Text>
            </View>
            <Pressable onPress={onClose} style={styles.close}>
              <Text style={styles.closeText}>×</Text>
            </Pressable>
          </View>
          <View style={styles.grid}>
            {sheet.options.map((option) => (
              <Pressable
                key={`${option.label}-${option.caption ?? ''}`}
                onPress={() => {
                  option.onSelect();
                  onClose();
                }}
                style={[
                  styles.option,
                  { borderColor: option.color ?? colors.border },
                  option.selected && { backgroundColor: '#F7F4FF' },
                ]}
              >
                <View style={[styles.dot, { backgroundColor: option.color ?? colors.primary }]}>
                  <Text style={styles.icon}>{option.icon ?? ' '}</Text>
                </View>
                <View style={styles.copy}>
                  <Text style={[styles.label, { color: option.color ?? colors.ink }]}>{option.label}</Text>
                  {option.caption ? <Text style={styles.caption}>{option.caption}</Text> : null}
                </View>
                {option.selected ? <Text style={styles.selected}>✓</Text> : null}
              </Pressable>
            ))}
          </View>
        </View>
      </View>
    </Modal>
  );
});

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', paddingHorizontal: 24 },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(31, 34, 44, 0.46)' },
  panel: { backgroundColor: '#FFFFFF', borderRadius: 22, gap: 16, maxHeight: '76%', padding: 18 },
  header: { alignItems: 'flex-start', flexDirection: 'row', gap: 12, justifyContent: 'space-between' },
  title: { color: colors.ink, fontSize: 21, fontWeight: '600', lineHeight: 28 },
  prompt: { color: colors.muted, fontSize: 14, fontWeight: '400', lineHeight: 21, marginTop: 4 },
  close: { alignItems: 'center', backgroundColor: '#F7E8E3', borderRadius: 18, height: 36, justifyContent: 'center', width: 36 },
  closeText: { color: '#B96F64', fontSize: 25, lineHeight: 28 },
  grid: { gap: 10 },
  option: { alignItems: 'center', backgroundColor: '#FFFFFF', borderRadius: 16, borderWidth: 1.5, flexDirection: 'row', gap: 10, minHeight: 54, paddingHorizontal: 12, paddingVertical: 9 },
  dot: { alignItems: 'center', borderRadius: 12, height: 24, justifyContent: 'center', width: 24 },
  icon: { color: '#FFFFFF', fontSize: 13, fontWeight: '500', lineHeight: 17 },
  copy: { flex: 1 },
  label: { fontSize: 16, fontWeight: '500', lineHeight: 21 },
  caption: { color: colors.muted, fontSize: 12, fontWeight: '400', lineHeight: 17, marginTop: 1 },
  selected: { color: '#817AE4', fontSize: 18, fontWeight: '500' },
});
