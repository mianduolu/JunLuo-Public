import { Pressable, StyleSheet, View } from 'react-native';
import { AppText as Text } from '../components/AppText';
import { colors } from '../theme/colors';
import type { WishDiscussion } from './wishPoolDiscussionState';
import { wishConfirmationLabel, WISH_PURPOSE_LABELS } from './wishPoolPresentation';

export type WishDiscussionCardProps = {
  discussion: WishDiscussion;
  busy?: boolean;
  onConfirm?: () => void;
  onContinue?: () => void;
  onEdit?: () => void;
};

// The host owns version validation and saving; the pool intentionally supplies no onConfirm.
export function WishDiscussionCard({ discussion, busy = false, onConfirm, onContinue, onEdit }: WishDiscussionCardProps) {
  const label = wishConfirmationLabel(discussion);
  if (discussion.closedAt !== undefined) return null;
  return <View style={styles.card} testID="wish-discussion-card">
    <Text style={styles.eyebrow}>正在商量 · {WISH_PURPOSE_LABELS[discussion.purpose]}</Text>
    <Text style={styles.body} selectable>{discussion.pendingText}</Text>
    <Text style={styles.note}>第 {discussion.revision} 版 · {label ? '已有回复，待核对确认' : '尚未形成可确认的结果'}</Text>
    {!onConfirm ? <Text style={styles.note}>到聊天中继续商量并核对结果。</Text> : null}
    <View style={styles.actions}>
      {onEdit && discussion.purpose !== 'cast_coin' && discussion.purpose !== 'revise' ? <Pressable disabled={busy} onPress={busy ? undefined : onEdit} accessibilityRole="button" accessibilityState={{ disabled: busy }} style={styles.button}>
        <Text style={styles.buttonText}>修改愿望</Text>
      </Pressable> : null}
      <Pressable disabled={busy || !onContinue} onPress={busy ? undefined : onContinue} accessibilityRole="button" accessibilityState={{ disabled: busy || !onContinue }} style={styles.button}>
        <Text style={styles.buttonText}>继续商量</Text>
      </Pressable>
      {label && onConfirm ? <Pressable disabled={busy} onPress={busy ? undefined : onConfirm} accessibilityRole="button" accessibilityState={{ disabled: busy }} style={[styles.button, styles.confirm]}>
        <Text style={styles.buttonText}>{label}</Text>
      </Pressable> : null}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#FFF7EF', borderRadius: 22, borderWidth: 1, borderColor: '#EDDDCD', padding: 20, gap: 12 },
  eyebrow: { color: '#8A6352', fontSize: 13, fontWeight: '600' },
  body: { color: colors.ink, fontSize: 18, lineHeight: 29 },
  note: { color: colors.muted, fontSize: 12, lineHeight: 19 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { minHeight: 48, borderRadius: 16, paddingHorizontal: 16, justifyContent: 'center', backgroundColor: '#EAE7E3' },
  confirm: { backgroundColor: '#F1DDD2' },
  buttonText: { color: '#766C68', fontSize: 14 },
});
