import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText as Text } from '../../components/AppText';
import { colors } from '../../theme/colors';

type Props = {
  emptyText: string;
  items: string[];
  title: string;
};

export const WeekReviewSection = memo(function WeekReviewSection({ emptyText, items, title }: Props) {
  return (
    <View style={styles.section}>
      <Text style={styles.title}>{title}</Text>
      {items.length ? items.map((item, index) => (
        <View key={`${title}-${index}`} style={styles.item}>
          <Text style={styles.bullet}>•</Text>
          <Text style={styles.itemText}>{item}</Text>
        </View>
      )) : (
        <Text style={styles.empty}>{emptyText}</Text>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  section: { backgroundColor: '#FFFFFF', borderColor: '#EDEAF9', borderRadius: 16, borderWidth: 1, gap: 9, padding: 14 },
  title: { color: colors.ink, fontSize: 16, fontWeight: '500', lineHeight: 21 },
  item: { alignItems: 'flex-start', flexDirection: 'row', gap: 8 },
  bullet: { color: '#817AE4', fontSize: 16, fontWeight: '500', lineHeight: 21 },
  itemText: { color: '#4F5565', flex: 1, fontSize: 14, fontWeight: '400', lineHeight: 21 },
  empty: { color: colors.muted, fontSize: 13, fontWeight: '400', lineHeight: 20 },
});
