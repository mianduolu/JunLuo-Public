import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Alert, BackHandler, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { colors } from '../theme/colors';
import type { TheaterSetupDraft, TheaterSetupErrors } from './theaterSetupDraft';
import type { TheaterSetupSession } from './theaterSetupSession';
import { TheaterFullScreenEditor } from './TheaterFullScreen';

function Button({ text, onPress, disabled = false, selected = false }: {
  text: string; onPress: () => void; disabled?: boolean; selected?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled, selected }} disabled={disabled}
    onPress={onPress} style={[styles.button, selected && styles.selected, disabled && styles.disabled]}>
    <Text style={styles.buttonText}>{text}</Text>
  </Pressable>;
}

function NumberSetting({ label, value, options, error, disabled, onChange, decimal = false }: {
  label: string; value: string; options: readonly (readonly [string, string])[];
  error?: string; disabled: boolean; decimal?: boolean; onChange: (value: string) => void;
}) {
  const [custom, setCustom] = useState(!options.some(([, number]) => number === value));
  return <View style={styles.field}>
    <Text style={styles.label}>{label}</Text>
    <View style={styles.buttons}>
      {options.map(([text, number]) => <Button key={number} text={text} disabled={disabled}
        selected={!custom && number === value} onPress={() => { setCustom(false); onChange(number); }} />)}
      <Button text="自定义" disabled={disabled} selected={custom} onPress={() => setCustom(true)} />
    </View>
    {custom && <TextInput accessibilityLabel={label} editable={!disabled} value={value} onChangeText={onChange}
      keyboardType={decimal ? 'decimal-pad' : 'number-pad'} style={styles.input} />}
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
  </View>;
}

function SetupForm({ draft, errors, disabled, onChange }: {
  draft: TheaterSetupDraft; errors: TheaterSetupErrors; disabled: boolean;
  onChange: (field: keyof TheaterSetupDraft, value: string) => void;
}) {
  const [more, setMore] = useState(false);
  const [fullField, setFullField] = useState<keyof TheaterSetupDraft | null>(null);
  useEffect(() => { if (Object.keys(errors).length) setMore(true); }, [errors]);
  const fields: { key: keyof TheaterSetupDraft; label: string; placeholder?: string; multiline?: boolean }[] = [
    { key: 'title', label: '剧场标题', placeholder: '留空自动取名' },
    { key: 'world', label: '世界设定', multiline: true },
    { key: 'youIdentity', label: '小仓鼠的故事身份', multiline: true },
    { key: 'youName', label: '小仓鼠的戏内称呼', placeholder: '小仓鼠' },
    { key: 'iIdentity', label: '白云小姐的故事身份', multiline: true },
    { key: 'iName', label: '白云小姐的戏内称呼', placeholder: '白云小姐' },
    { key: 'tone', label: '故事氛围', multiline: true },
    { key: 'openingPrompt', label: '开场提示', multiline: true },
  ];
  return <>
    {fields.map(({ key, label, placeholder, multiline }) => <View key={key} style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {['world', 'youIdentity', 'iIdentity', 'openingPrompt'].includes(key) &&
        <Button text="全屏编辑" disabled={disabled} onPress={() => setFullField(key)} />}
      <TextInput accessibilityLabel={label} value={draft[key]} onChangeText={(value) => onChange(key, value)}
        editable={!disabled} placeholder={placeholder} placeholderTextColor={colors.muted} multiline={multiline}
        style={[styles.input, multiline && styles.multiline]} textAlignVertical={multiline ? 'top' : 'center'} />
    </View>)}
    {fullField && <TheaterFullScreenEditor title={fields.find(v => v.key === fullField)!.label}
      value={draft[fullField]} disabled={disabled} onChange={value => onChange(fullField, value)} onClose={() => setFullField(null)} />}
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: more }} onPress={() => setMore(!more)} style={styles.more}>
      <Text style={styles.label}>更多设置</Text><Text style={styles.muted}>{more ? '−' : '+'}</Text>
    </Pressable>
    {more && <View style={styles.advanced}>
      <NumberSetting label="发挥幅度" value={draft.temperature} decimal disabled={disabled} error={errors.temperature}
        options={[["稳一点", "0.5"], ["自然", "0.8"], ["放开演", "1.1"]]}
        onChange={(value) => onChange('temperature', value)} />
      <NumberSetting label="每次带上多少条最近台词" value={draft.contextLimit} disabled={disabled} error={errors.contextLimit}
        options={[["轻便 · 12 条", "12"], ["标准 · 20 条", "20"], ["长剧情 · 40 条", "40"]]}
        onChange={(value) => onChange('contextLimit', value)} />
      <NumberSetting label="小抄提醒" value={draft.summaryInterval} disabled={disabled} error={errors.summaryInterval}
        options={[["经常整理 · 10 条", "10"], ["标准 · 20 条", "20"], ["久一点 · 40 条", "40"], ["关闭按条数提醒", "0"]]}
        onChange={(value) => onChange('summaryInterval', value)} />
    </View>}
  </>;
}

export function TheaterSetupPanel({ session, onLeave, renderHistoryActions, historyContent, embedded = false }: {
  session: TheaterSetupSession; onLeave: () => void; renderHistoryActions?: (storyId: string) => ReactNode;
  historyContent?: ReactNode;
  embedded?: boolean;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const insets = useSafeAreaInsets();
  useEffect(() => { void session.refresh(); }, [session]);
  useEffect(() => {
    const listener = BackHandler.addEventListener('hardwareBackPress', () => {
      const current = session.getSnapshot();
      if (current.saving || current.dialog) return true;
      if (current.editor) session.history();
      else session.requestLeave(onLeave);
      return true;
    });
    return () => listener.remove();
  }, [session, onLeave]);
  useEffect(() => {
    const dialog = state.dialog;
    if (!dialog) return;
    if (dialog === 'save-error') {
      Alert.alert('没有保存成功', '填写的内容还在，可以重试。', [
        { text: '继续编辑', onPress: () => session.continueEditing(), style: 'cancel' },
        { text: '重试保存', onPress: () => { void session.retry(); } },
      ], { cancelable: true, onDismiss: () => session.continueEditing() });
    } else {
      const isNew = dialog === 'leave-new';
      Alert.alert(isNew ? '这份设定还没保存' : '设定修改还没保存',
        isNew ? '要保存为草稿，还是放弃这次填写？' : '要保存这次修改，还是保留原来的设定？', [
          { text: isNew ? '继续填写' : '继续修改', style: 'cancel', onPress: () => session.continueEditing() },
          { text: isNew ? '放弃内容' : '放弃修改', style: 'destructive', onPress: () => session.discardAndLeave() },
          { text: isNew ? '保存为草稿' : '保存修改', onPress: () => { void session.saveAndLeave(); } },
        ], { cancelable: true, onDismiss: () => session.continueEditing() });
    }
  }, [state.dialog, session]);

  const editor = state.editor;
  const source = editor?.storyId ? state.stories.find((story) => story.id === editor.storyId) : undefined;
  return <KeyboardAvoidingView style={[styles.root, { paddingTop: embedded ? 0 : insets.top }]} behavior={!embedded && Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
      <View style={styles.header}>
        <Text style={styles.heading}>{editor ? editor.storyId ? '本场设定' : '新剧场设定' : '历史'}</Text>
        {editor && <Button text="历史" disabled={state.saving} onPress={() => session.history()} />}
      </View>
      {state.loading && (editor || !historyContent) && <Text style={styles.muted}>正在读取…</Text>}
      {state.loadError && (editor || !historyContent) && <View style={styles.field}><Text style={styles.muted}>暂时没能读到小剧场</Text>
        <Button text="重试" onPress={() => { void session.refresh(); }} /></View>}
      {!!state.notice && <Text accessibilityLiveRegion="polite" style={styles.muted}>{state.notice}</Text>}
      {editor ? <>
        {editor.copied && <Text style={styles.muted}>已复制设定，尚未保存。不会带入原场的剧情。</Text>}
        <SetupForm key={editor.storyId ?? (editor.copied ? 'copy' : 'new')} draft={editor.draft} errors={state.errors}
          disabled={state.saving} onChange={(field, value) => session.change(field, value)} />
        {state.saving && <Text accessibilityLiveRegion="polite" style={styles.muted}>正在保存…</Text>}
        <View style={styles.buttons}>
          {(!editor.storyId || editor.wasDraft) && <Button text="保存为草稿" disabled={state.saving} onPress={() => { void session.save(true); }} />}
          <Button text="保存设定" selected disabled={state.saving} onPress={() => { void session.save(false); }} />
        </View>
        {source && <Button text="用这份设定新开一场" disabled={state.saving} onPress={() => session.copyStory(source)} />}
      </> : historyContent ?? <>
        {!state.loading && !state.loadError && !state.stories.length && <Text style={styles.muted}>还没有小剧场。先写下设定，再开始一段故事。</Text>}
        <Button text="新建小剧场" disabled={state.loading || state.loadError} onPress={() => session.newStory()} />
        {state.stories.map((story) => <View key={story.id} style={styles.card}>
          <Pressable accessibilityRole="button" onPress={() => session.selectStory(story)}>
            <Text style={styles.cardTitle}>{story.title}</Text>
            {!!story.settings.world && <Text numberOfLines={2} style={styles.muted}>{story.settings.world}</Text>}
          </Pressable>
          <View style={styles.buttons}>
            <Button text={story.isDraft ? '继续填写' : '设定'} onPress={() => session.editStory(story)} />
            <Button text="更改小剧场名称" onPress={() => session.beginRename(story)} />
          </View>
          {renderHistoryActions?.(story.id)}
        </View>)}
      </>}
    </ScrollView>
    <Modal transparent visible={!!state.rename} animationType="fade" onRequestClose={() => session.cancelRename()}>
      <KeyboardAvoidingView style={[styles.scrim, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={styles.rename}>
          <Text style={styles.heading}>更改小剧场名称</Text>
          <TextInput accessibilityLabel="剧场标题" autoFocus value={state.rename?.title ?? ''} editable={!state.saving}
            onChangeText={(value) => session.changeName(value)} style={styles.input} placeholder="留空自动取名" />
          {state.saving && <Text style={styles.muted}>正在保存…</Text>}
          <View style={styles.buttons}>
            <Button text="取消" disabled={state.saving} onPress={() => session.cancelRename()} />
            <Button text="保存" disabled={state.saving} selected onPress={() => { void session.saveName(); }} />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  </KeyboardAvoidingView>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: 18, gap: 18 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  heading: { fontSize: 20, fontWeight: '700', color: colors.ink, flexShrink: 1 },
  field: { gap: 8 },
  label: { fontSize: 15, fontWeight: '600', color: colors.ink },
  muted: { fontSize: 13, lineHeight: 21, color: colors.muted },
  input: { minHeight: 46, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 15, lineHeight: 23, color: colors.ink, backgroundColor: colors.cardStrong, borderWidth: 1, borderColor: colors.border },
  multiline: { minHeight: 100 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: 14, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  buttonText: { color: colors.ink, fontSize: 14 },
  selected: { backgroundColor: colors.secondary },
  disabled: { opacity: 0.5 },
  more: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 48 },
  advanced: { gap: 22 },
  error: { fontSize: 13, color: '#A8443A', lineHeight: 20 },
  card: { padding: 16, gap: 12, backgroundColor: colors.card, borderRadius: 18 },
  cardTitle: { fontSize: 16, fontWeight: '600', color: colors.ink, marginBottom: 6 },
  scrim: { flex: 1, backgroundColor: 'rgba(30,40,55,0.3)', justifyContent: 'center', paddingHorizontal: 20 },
  rename: { padding: 20, borderRadius: 20, backgroundColor: colors.cream, gap: 18 },
});
