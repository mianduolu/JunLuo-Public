import { useSyncExternalStore } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText as Text } from '../components/AppText';
import { colors } from '../theme/colors';
import { backstageText as copy, type TheaterBackstageSession } from './theaterBackstageSession';

function Button({ label, action, disabled }: { label: string; action: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }}
    disabled={disabled} onPress={action} style={[styles.button, disabled && styles.disabled]}><Text>{label}</Text></Pressable>;
}
function Choice({ label, checked, disabled, action }: { label: string; checked: boolean; disabled: boolean; action: () => void }) {
  return <Pressable accessibilityRole="checkbox" accessibilityLabel={label} accessibilityState={{ checked, disabled }}
    disabled={disabled} onPress={action} style={[styles.choice, checked && styles.selected, disabled && styles.disabled]}>
    <Text style={styles.check}>{checked ? '✓' : '○'}</Text><Text style={styles.choiceText}>{label}</Text>
  </Pressable>;
}

export function TheaterBackstagePanel({ session }: { session: TheaterBackstageSession }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const insets = useSafeAreaInsets();
  const { source, selection, busy, stage } = state;
  const editing = !!source && !!selection && (stage === 'selecting' || stage === 'failed');
  const visible = ['loading', 'selecting', 'overflow', 'failed'].includes(stage);
  return <>
    {stage === 'gone' && <Text accessibilityRole="alert">{state.notice}</Text>}
    <Modal visible={visible} transparent animationType="none" onRequestClose={session.cancel}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.fill}>
        <View style={[styles.scrim, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12,
          paddingLeft: insets.left + 16, paddingRight: insets.right + 16 }]}>
          <View style={styles.panel} accessibilityViewIsModal>
            {stage !== 'loading' && <Text accessibilityRole="header">{copy.title}</Text>}
            {stage === 'selecting' && <Text>{copy.description}</Text>}
            {stage === 'overflow' && <Text accessibilityRole="alert">{copy.overflow}</Text>}
            {stage === 'failed' && <Text accessibilityRole="alert">{copy.failed}</Text>}
            {busy && <ActivityIndicator />}
            {editing && <ScrollView keyboardShouldPersistTaps="handled" style={styles.scroll} contentContainerStyle={styles.content}>
              <Text>{`故事：《${source.title}》· ${source.branchName}`}</Text>
              {(['world', 'checkpoint'] as const).map(key => {
                if ((key === 'world' && (state.mode === 'slim' || !source.world.trim())) || (key === 'checkpoint' && !source.checkpoint)) return null;
                const label = key === 'world' ? '世界设定' : '前情小抄';
                return <View key={key} style={styles.group}>
                  <Choice label={label} checked={selection[key].included} disabled={busy} action={() => session.toggleText(key)} />
                  <TextInput accessibilityLabel={label} multiline editable={!busy && selection[key].included}
                    value={selection[key].text} onChangeText={value => session.editText(key, value)}
                    style={[styles.input, !selection[key].included && styles.disabled]} />
                </View>;
              })}
              {!!source.anchors.length && <Text>剧情锚点</Text>}
              {source.anchors.map(anchor => <Choice key={anchor.id} label={anchor.content} checked={selection.anchorIds.includes(anchor.id)}
                disabled={busy} action={() => session.toggleItem('anchorIds', anchor.id)} />)}
              {state.mode === 'full' && !!source.lines.length && <Text>最近台词</Text>}
              {state.mode === 'full' && source.lines.map(line => <Choice key={line.id} label={`${source.names[line.subject]}：${line.content}`}
                checked={selection.lineIds.includes(line.id)} disabled={busy} action={() => session.toggleItem('lineIds', line.id)} />)}
            </ScrollView>}
            <View style={styles.actions}>
              {stage === 'overflow' ? <>
                <Button label="暂时不带" disabled={busy} action={() => { void session.skip(); }} />
                <Button label="继续精简" disabled={busy} action={session.continueEditing} />
              </> : <>
                <Button label="取消" disabled={busy} action={session.cancel} />
                {stage !== 'loading' && <Button label={stage === 'failed' ? '重试' : copy.entry} disabled={busy}
                  action={() => { void (stage === 'failed' ? session.retry() : session.confirm()); }} />}
              </>}
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  </>;
}

// Candidate owner places this above, not inside, the existing ChatComposer.
export function TheaterBackstageBanner({ session }: { session: TheaterBackstageSession }) {
  const { prepared, busy, stage, notice } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  if (stage === 'failed') return <View style={styles.banner}><Text style={styles.choiceText} accessibilityRole="alert">{copy.failed}</Text>
    <Button label="取消" disabled={busy} action={session.cancel} />
    <Button label="重试" disabled={busy} action={() => { void session.retry(); }} /></View>;
  if (!prepared) return stage === 'gone' ? <Text accessibilityRole="alert">{notice}</Text> : null;
  if (prepared.batch && prepared.batch.usedCount >= 6) return <View style={styles.banner}>
    <Text style={styles.choiceText}>{copy.expired}</Text>
    <Button label="再用六次" disabled={busy} action={() => { void session.renew(); }} />
    <Button label="收起" disabled={busy} action={() => { void session.dismiss(); }} />
  </View>;
  return <View style={styles.banner}><Text style={styles.choiceText}>{`故事：《${prepared.source.title}》· ${prepared.source.branchName}`}</Text>
    <Button label="不带了" disabled={busy} action={() => { void session.dismiss(); }} /></View>;
}
const styles = StyleSheet.create({
  fill: { flex: 1 }, scrim: { flex: 1, justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.22)' },
  panel: { maxHeight: '94%', backgroundColor: colors.cardStrong, borderRadius: 20, padding: 16, gap: 12 },
  scroll: { flexShrink: 1 }, content: { gap: 12, paddingBottom: 8 }, group: { gap: 8 },
  choice: { flexDirection: 'row', gap: 10, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 12 },
  selected: { backgroundColor: colors.card }, check: { width: 18, color: colors.ink }, choiceText: { flex: 1, flexShrink: 1 },
  input: { minHeight: 96, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 12,
    color: colors.ink, fontSize: 15, lineHeight: 23, textAlignVertical: 'top' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end' },
  button: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, paddingVertical: 10 },
  disabled: { opacity: 0.45 }, banner: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 8 },
});
