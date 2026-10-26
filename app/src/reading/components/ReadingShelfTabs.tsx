import { Pressable, StyleSheet, View } from 'react-native';
import { AppText as Text } from '../../components/AppText';

export function ReadingShelfTabs({ active, onBooks, onProgrammes }: {
  active: 'books' | 'programmes'; onBooks: () => void; onProgrammes: () => void;
}) {
  return <View style={styles.tabs} accessibilityRole="tablist">
    {([{ key: 'books', label: '书架', onPress: onBooks },
      { key: 'programmes', label: '节目单', onPress: onProgrammes }] as const).map(tab => (
      <Pressable key={tab.key} accessibilityRole="tab" accessibilityState={{ selected: active === tab.key }}
        onPress={tab.onPress} style={({ pressed }) => [styles.tab, active === tab.key && styles.selected, pressed && styles.pressed]}>
        <Text style={[styles.label, active === tab.key && styles.selectedLabel]}>{tab.label}</Text>
      </Pressable>
    ))}
  </View>;
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', marginHorizontal: 16, marginBottom: 16, padding: 4, gap: 4, backgroundColor: '#EAF0EC', borderRadius: 16 },
  tab: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
  selected: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DCE9E4' },
  label: { color: '#728598', fontSize: 15, fontWeight: '400' },
  pressed: { opacity: 0.65 },
  selectedLabel: { color: '#476D8D', fontWeight: '500' },
});
