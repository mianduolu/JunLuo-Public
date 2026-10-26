import { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import {
  approveSocialDraft,
  discardSocialDraft,
  loadSocialDrafts,
  updateSocialDraft,
  type SocialDraft,
} from '../life/socialAgent';
import { colors } from '../theme/colors';
import type { Navigate } from '../types/navigation';

type Props = { navigate: Navigate };
type DraftFilter = 'pending' | 'archived';

function formatDraftTime(value: number) {
  return new Date(value).toLocaleString('zh-CN', {
    day: 'numeric',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: 'numeric',
  });
}

function statusLabel(status: SocialDraft['status']) {
  if (status === 'approved') return '已看过';
  if (status === 'discarded') return '已丢掉';
  return '待看看';
}

function draftKindLabel(kind: SocialDraft['kind']) {
  return kind === 'post' ? '短帖草稿' : '旧评论草稿';
}

export function SocialDraftBoxScreen({ navigate }: Props) {
  const insets = useSafeAreaInsets();
  const [drafts, setDrafts] = useState<SocialDraft[]>([]);
  const [filter, setFilter] = useState<DraftFilter>('pending');

  const refresh = () => {
    void loadSocialDrafts().then(setDrafts);
  };

  useEffect(() => {
    refresh();
  }, []);

  const pendingCount = drafts.filter((draft) => draft.status === 'pending').length;
  const archivedCount = drafts.length - pendingCount;
  const visibleDrafts = useMemo(
    () => drafts.filter((draft) => filter === 'pending' ? draft.status === 'pending' : draft.status !== 'pending'),
    [drafts, filter],
  );

  const editDraft = (draft: SocialDraft, patch: Partial<Pick<SocialDraft, 'content' | 'title'>>) => {
    setDrafts((current) => current.map((item) => item.id === draft.id ? { ...item, ...patch, updatedAt: Date.now() } : item));
    void updateSocialDraft(draft.id, patch).then(refresh);
  };

  const markRead = (draft: SocialDraft) => {
    void approveSocialDraft(draft.id).then(refresh);
  };

  const removeDraft = (draft: SocialDraft) => {
    Alert.alert('丢掉这条草稿？', draft.title || draft.content.slice(0, 36), [
      { text: '先留着', style: 'cancel' },
      { text: '丢掉', style: 'destructive', onPress: () => void discardSocialDraft(draft.id).then(refresh) },
    ]);
  };

  return (
    <View style={[styles.page, { paddingTop: Math.max(insets.top + 18, 42) }]}>
      <View style={styles.header}>
        <Pressable accessibilityLabel="返回设置" onPress={() => navigate('settings')} style={styles.backButton}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>君落草稿箱</Text>
          <Text style={styles.subtitle}>白云小姐想写出去的话，会先落在这里。</Text>
        </View>
        <Pressable onPress={refresh} style={styles.refreshButton}>
          <Text style={styles.refreshText}>刷新</Text>
        </Pressable>
      </View>

      <View style={styles.tabs}>
        <Pressable onPress={() => setFilter('pending')} style={[styles.tab, filter === 'pending' && styles.tabActive]}>
          <Text style={[styles.tabText, filter === 'pending' && styles.tabTextActive]}>待看看 {pendingCount}</Text>
        </Pressable>
        <Pressable onPress={() => setFilter('archived')} style={[styles.tab, filter === 'archived' && styles.tabActive]}>
          <Text style={[styles.tabText, filter === 'archived' && styles.tabTextActive]}>归档 {archivedCount}</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        {visibleDrafts.length ? visibleDrafts.map((draft) => {
          const editable = draft.status === 'pending';
          return (
            <View key={draft.id} style={styles.draftCard}>
              <View style={styles.draftMetaRow}>
                <Text style={styles.draftMeta}>
                  {draftKindLabel(draft.kind)} · {statusLabel(draft.status)} · {formatDraftTime(draft.createdAt)}
                </Text>
              </View>
              {draft.kind === 'post' ? (
                <TextInput
                  editable={editable}
                  onChangeText={(title) => editDraft(draft, { title })}
                  placeholder="标题"
                  placeholderTextColor="#8AA3B2"
                  style={[styles.input, !editable && styles.inputReadonly]}
                  value={draft.title ?? ''}
                />
              ) : null}
              <TextInput
                editable={editable}
                multiline
                onChangeText={(content) => editDraft(draft, { content })}
                placeholder="草稿内容"
                placeholderTextColor="#8AA3B2"
                style={[styles.input, styles.contentInput, !editable && styles.inputReadonly]}
                value={draft.content}
              />
              <Text style={styles.reason}>{draft.reason}</Text>
              {editable ? (
                <View style={styles.actions}>
                  <Pressable onPress={() => markRead(draft)} style={styles.primaryAction}>
                    <Text style={styles.primaryActionText}>标记已看</Text>
                  </Pressable>
                  <Pressable onPress={() => removeDraft(draft)} style={styles.dangerAction}>
                    <Text style={styles.dangerActionText}>丢掉</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          );
        }) : (
          <View style={styles.emptyBox}>
            <Text style={styles.emptyTitle}>{filter === 'pending' ? '现在没有待看的草稿' : '归档里还没有草稿'}</Text>
            <Text style={styles.emptyText}>
              白云小姐以后想写短帖风格的内容时，会先放到君落里。这里不会自动发布，也不会碰到账号。
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    backgroundColor: '#F7FAF8',
    flex: 1,
    paddingHorizontal: 18,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
    minHeight: 58,
  },
  backButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#DDEBE2',
    borderRadius: 18,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  backText: {
    color: '#527765',
    fontSize: 34,
    fontWeight: '400',
    lineHeight: 38,
  },
  headerCopy: {
    flex: 1,
  },
  title: {
    color: colors.ink,
    fontSize: 25,
    fontWeight: '600',
    lineHeight: 31,
  },
  subtitle: {
    color: '#647887',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 2,
  },
  refreshButton: {
    alignItems: 'center',
    backgroundColor: '#DCEFE2',
    borderRadius: 14,
    minHeight: 38,
    justifyContent: 'center',
    paddingHorizontal: 13,
  },
  refreshText: {
    color: '#43725A',
    fontSize: 13,
    fontWeight: '600',
  },
  tabs: {
    backgroundColor: '#EAF4EF',
    borderRadius: 14,
    flexDirection: 'row',
    gap: 6,
    marginBottom: 12,
    padding: 5,
  },
  tab: {
    alignItems: 'center',
    borderRadius: 10,
    flex: 1,
    minHeight: 36,
    justifyContent: 'center',
  },
  tabActive: {
    backgroundColor: '#FFFFFF',
  },
  tabText: {
    color: '#6D8290',
    fontSize: 13,
    fontWeight: '500',
  },
  tabTextActive: {
    color: '#3F7259',
    fontWeight: '700',
  },
  content: {
    gap: 12,
    paddingBottom: 36,
  },
  draftCard: {
    backgroundColor: '#FFFFFF',
    borderColor: '#DDEBE2',
    borderRadius: 8,
    borderWidth: 1,
    padding: 13,
  },
  draftMetaRow: {
    flexDirection: 'row',
    marginBottom: 9,
  },
  draftMeta: {
    color: '#5D7D6D',
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 18,
  },
  input: {
    backgroundColor: '#FBFEFC',
    borderColor: '#DDEBE2',
    borderRadius: 8,
    borderWidth: 1,
    color: colors.ink,
    fontSize: 14,
    lineHeight: 21,
    marginBottom: 8,
    minHeight: 42,
    paddingHorizontal: 11,
    paddingVertical: 9,
  },
  inputReadonly: {
    backgroundColor: '#F3F7F5',
    color: '#5F6F78',
  },
  contentInput: {
    minHeight: 128,
    textAlignVertical: 'top',
  },
  reason: {
    color: '#6B8190',
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 10,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  primaryAction: {
    alignItems: 'center',
    backgroundColor: '#B8DDBE',
    borderRadius: 8,
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: 13,
  },
  primaryActionText: {
    color: '#356B46',
    fontSize: 12,
    fontWeight: '700',
  },
  dangerAction: {
    alignItems: 'center',
    backgroundColor: '#FFE3DF',
    borderRadius: 8,
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: 13,
  },
  dangerActionText: {
    color: '#B95048',
    fontSize: 12,
    fontWeight: '700',
  },
  emptyBox: {
    backgroundColor: '#FFFFFF',
    borderColor: '#DDEBE2',
    borderRadius: 8,
    borderWidth: 1,
    padding: 16,
  },
  emptyTitle: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '600',
    lineHeight: 22,
    marginBottom: 6,
  },
  emptyText: {
    color: '#6B8190',
    fontSize: 13,
    lineHeight: 20,
  },
});
