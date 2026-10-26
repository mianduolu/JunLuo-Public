import { useSyncExternalStore } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { colors } from '../theme/colors';
import type { TheaterSearchResult } from './theaterSearch';
import type { TheaterSearchSession } from './theaterSearchSession';

function Button({ label, onPress, disabled = false, selected = false }: {
  label: string; onPress: () => void; disabled?: boolean; selected?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled}
    accessibilityState={{ disabled, selected }} onPress={onPress}
    style={[styles.button, selected && styles.selected, disabled && styles.disabled]}>
    <Text style={styles.label}>{label}</Text>
  </Pressable>;
}

function Source({ result }: { result: TheaterSearchResult }) {
  return <>
    <Text style={styles.muted}>{result.source}</Text>
    {result.kind === 'alternative' && <Text style={styles.muted}>备选版本</Text>}
    {result.kind === 'anchor' && <>
      <Text style={styles.muted}>{result.ordinal === null ? '发生位置待选择' : `发生在：第 ${result.ordinal} 句`}</Text>
      {result.needsReview && <Text style={styles.muted}>需要核对</Text>}
    </>}
  </>;
}

export function TheaterSearchPanel({ session, onNavigate, onRead }: {
  session: TheaterSearchSession;
  onNavigate: (result: TheaterSearchResult, action?: 'switch' | 'continue') => void | Promise<void>;
  onRead?: (result: TheaterSearchResult) => void;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const insets = useSafeAreaInsets(), preview = state.preview;
  const navigate = async (result: TheaterSearchResult, action?: 'switch' | 'continue') => {
    const fresh = action ? await session.validateTarget(result) : await session.select(result);
    if (fresh) await onNavigate(fresh, action);
  };
  const title = state.error ? '搜索剧情' : preview?.kind === 'checkpoint' ? '小抄预览'
    : preview ? `预览：${preview.branchName}` : '搜索剧情';
  return <Modal visible={state.visible} transparent animationType="none"
    onRequestClose={() => { if (preview || state.error === 'missing') void session.returnToResults(); else session.close(); }}>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={[styles.scrim, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12,
        paddingLeft: insets.left + 16, paddingRight: insets.right + 16 }]}>
      <View accessibilityViewIsModal style={styles.panel}>
        <Text accessibilityRole="header" style={styles.heading}>{title}</Text>
        {!preview && state.error !== 'missing' && <>
          <TextInput accessibilityLabel="搜索台词、走向、锚点或小抄" placeholder="搜索台词、走向、锚点或小抄"
            value={state.query} onChangeText={text => { void session.setQuery(text); }} style={styles.input} />
          <View style={styles.row}>
            <Button label="当前走向" selected={state.scope === 'branch'} onPress={() => { void session.setScope('branch'); }} />
            <Button label="整个小剧场" selected={state.scope === 'story'} onPress={() => { void session.setScope('story'); }} />
          </View>
        </>}
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {state.error === 'read' ? <>
            <Text style={styles.body}>暂时无法读取搜索内容。</Text>
            <Button label="重试" onPress={() => { void session.retry(); }} />
          </> : state.error === 'missing' ? <>
            <Text style={styles.body}>这条内容已不存在。</Text>
            <Button label="返回搜索结果" onPress={() => { void session.returnToResults(); }} />
          </> : preview ? <>
            <Source result={preview} />
            {preview.kind === 'alternative' && <Text style={styles.muted}>仅预览</Text>}
            {preview.kind === 'branch' ? preview.messages.map(({ version, speaker }) => <View key={version.id} style={styles.result}>
              <Text style={styles.muted}>{speaker}</Text><Text selectable style={styles.body}>{version.content}</Text>
            </View>) : <Text selectable style={styles.body}>{preview.content}</Text>}
            {onRead && (preview.kind === 'dialogue' || preview.kind === 'alternative') &&
              <Button label="专心阅读" disabled={state.loading} onPress={() => onRead(preview)} />}
            <Button label="返回搜索结果" disabled={state.loading} onPress={() => { void session.returnToResults(); }} />
            {preview.kind === 'alternative' ?
              <Button label="从这一版继续" disabled={state.loading} onPress={() => { void navigate(preview, 'continue'); }} />
              : preview.kind !== 'checkpoint' && preview.branchId !== state.binding?.branchId &&
              <Button label="切换到这条走向" disabled={state.loading} onPress={() => { void navigate(preview, 'switch'); }} />}
          </> : !state.loading && state.searched && state.query.trim() && !state.results.length ?
            <Text style={styles.body}>没有找到相关内容。</Text> : !state.loading && state.results.map(result =>
            <Pressable key={result.id} accessibilityRole="button" accessibilityLabel={result.source}
              onPress={() => { void navigate(result); }} style={styles.result}>
              <Source result={result} /><Text style={styles.body}>{result.content}</Text>
            </Pressable>)}
        </ScrollView>
        <Button label="返回" onPress={() => session.close()} />
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(30,40,50,0.16)', justifyContent: 'center' },
  panel: { maxHeight: '100%', borderRadius: 20, padding: 16, gap: 12, backgroundColor: colors.cardStrong },
  heading: { color: colors.ink, fontSize: 18, fontWeight: '600' },
  input: { color: colors.ink, borderColor: colors.border, borderWidth: 1, borderRadius: 12, padding: 12, fontSize: 15 },
  scroll: { flexShrink: 1 }, content: { gap: 12 }, row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  result: { paddingVertical: 12, gap: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  body: { color: colors.ink, fontSize: 15, lineHeight: 23 }, muted: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  button: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, backgroundColor: colors.card },
  selected: { backgroundColor: colors.mint }, disabled: { opacity: 0.5 }, label: { color: colors.ink, fontSize: 14 },
});
