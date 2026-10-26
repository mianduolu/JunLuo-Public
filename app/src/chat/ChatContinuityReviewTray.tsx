
import {
  Pressable,
  ScrollView,
  StyleSheet,
  type StyleProp,
  View,
  type ViewStyle,
} from 'react-native';
import Animated from 'react-native-reanimated';

import type { BaiyunContinuityCandidate } from '../ai/behavior/continuityLedger';
import { AppText as Text } from '../components/AppText';
import { colors } from '../theme/colors';
import type { ChatContinuityReviewItem } from './useChatContinuityReviewController';

export type ChatContinuityReviewTrayProps = {
  busyCandidateIds: readonly string[];
  items: readonly ChatContinuityReviewItem[];
  keyboardStyle: StyleProp<ViewStyle>;
  onAccept: (candidate: BaiyunContinuityCandidate) => void;
  onDismiss: (candidate: BaiyunContinuityCandidate) => void;
  onOpen: () => void;
  onUndo: (candidate: BaiyunContinuityCandidate) => void;
};

export function ChatContinuityReviewTray({
  busyCandidateIds,
  items,
  keyboardStyle,
  onAccept,
  onDismiss,
  onOpen,
  onUndo,
}: ChatContinuityReviewTrayProps) {
  if (!items.length) return null;
  return (
    <Animated.View style={[styles.tray, keyboardStyle]}>
      <ScrollView
        contentContainerStyle={styles.content}
        horizontal
        keyboardShouldPersistTaps="handled"
        showsHorizontalScrollIndicator={false}
      >
        {items.map((item) => {
          const { candidate } = item;
          const busy = busyCandidateIds.includes(candidate.id);
          const accepted = candidate.state === 'accepted';
          return (
            <View key={candidate.id} style={styles.card}>
              <View style={styles.header}>
                <Text style={styles.title}>{item.title}</Text>
                <Text style={styles.confidence}>
                  {Math.round(candidate.confidence * 100)}%
                </Text>
              </View>
              <Text style={styles.kind}>{item.kindLabel}</Text>
              {item.stateLabel ? (
                <Text style={styles.meta}>{item.stateLabel}</Text>
              ) : null}
              <Text style={styles.excerpt} numberOfLines={3}>
                {item.sourceExcerpt}
              </Text>
              <View style={styles.actions}>
                <Pressable
                  disabled={busy}
                  onPress={onOpen}
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    pressed && styles.buttonPressed,
                  ]}
                >
                  <Text style={styles.secondaryText}>查看</Text>
                </Pressable>
                {accepted ? (
                  <Pressable
                    disabled={busy}
                    onPress={() => onUndo(candidate)}
                    style={({ pressed }) => [
                      styles.secondaryButton,
                      pressed && styles.buttonPressed,
                      busy && styles.buttonDisabled,
                    ]}
                  >
                    <Text style={styles.secondaryText}>撤销这次登记</Text>
                  </Pressable>
                ) : (
                  <>
                    <Pressable
                      disabled={busy}
                      onPress={() => onDismiss(candidate)}
                      style={({ pressed }) => [
                        styles.secondaryButton,
                        pressed && styles.buttonPressed,
                        busy && styles.buttonDisabled,
                      ]}
                    >
                      <Text style={styles.secondaryText}>暂不登记</Text>
                    </Pressable>
                    <Pressable
                      disabled={busy}
                      onPress={() => onAccept(candidate)}
                      style={({ pressed }) => [
                        styles.primaryButton,
                        pressed && styles.buttonPressed,
                        busy && styles.buttonDisabled,
                      ]}
                    >
                      <Text style={styles.primaryText}>
                        {candidate.kind === 'create_event' ? '确认登记' : '确认状态'}
                      </Text>
                    </Pressable>
                  </>
                )}
              </View>
            </View>
          );
        })}
      </ScrollView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  tray: {
    paddingBottom: 8,
  },
  content: {
    gap: 10,
    paddingHorizontal: 14,
  },
  card: {
    width: 292,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(157, 134, 185, 0.24)',
    backgroundColor: 'rgba(255, 252, 255, 0.96)',
    padding: 13,
    gap: 6,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  title: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '700',
  },
  confidence: {
    color: colors.muted,
    fontSize: 11,
  },
  kind: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: '600',
  },
  meta: {
    color: colors.muted,
    fontSize: 11,
  },
  excerpt: {
    color: colors.ink,
    fontSize: 13,
    lineHeight: 19,
  },
  actions: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 3,
  },
  primaryButton: {
    borderRadius: 999,
    backgroundColor: colors.primary,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  secondaryButton: {
    borderRadius: 999,
    backgroundColor: 'rgba(157, 134, 185, 0.12)',
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  primaryText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  secondaryText: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: '600',
  },
  buttonPressed: {
    opacity: 0.72,
  },
  buttonDisabled: {
    opacity: 0.45,
  },
});


