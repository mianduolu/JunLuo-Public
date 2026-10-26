import { ScrollView, StyleSheet, View } from 'react-native';
import { AppText as Text } from '../components/AppText';
import { WishDiscussionCard } from '../wishPool/WishDiscussionCard';
import { WishPoolPond } from '../wishPool/WishPoolPond';
import type { ChatWishControllerState } from './useChatWishController';

export function ChatWishDiscussion({ discussion, busy, error, onConfirm, onContinue, onEdit, castKey, onCastSettled }: ChatWishControllerState) {
  if (!discussion && !error && !castKey) return null;
  return <ScrollView testID="chat-wish-discussion" style={styles.frame} contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
    {discussion ? <WishDiscussionCard discussion={discussion} busy={busy} onConfirm={onConfirm} onContinue={onContinue} onEdit={onEdit} /> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {castKey > 0 ? <View><Text style={styles.note}>投币已保存</Text><WishPoolPond key={castKey} motion="cast" onSettled={onCastSettled} /></View> : null}
  </ScrollView>;
}

const styles = StyleSheet.create({
  frame: { maxHeight: 280, flexGrow: 0 },
  container: { marginHorizontal: 16, marginVertical: 8, gap: 8 },
  error: { color: '#9C443D', fontSize: 13, lineHeight: 21 },
  note: { color: '#687E82', fontSize: 12, lineHeight: 19, textAlign: 'center' },
});
