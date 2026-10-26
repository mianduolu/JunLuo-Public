import { useEffect, useSyncExternalStore } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText as Text } from '../components/AppText';
import { colors } from '../theme/colors';
import { theaterCheckpointParagraphs, theaterCoCreationSentences, theaterMaterialLength, THEATER_CREATION_BUDGET } from './theaterCoCreationMaterial';
import { theaterCoCreationText as copy, type TheaterCoCreationSelectionSession } from './theaterCoCreationSelectionSession';
import { subscribeTheaterCoCreation } from './theaterCoCreationRuntime';

function Button({ title, onPress, disabled = false }: { title: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled}
    style={[styles.button, disabled && styles.disabled]} onPress={onPress}><Text>{title}</Text></Pressable>;
}
export function TheaterCoCreationSelectionPanel({ session, storyId, refreshKey }: {
  session: TheaterCoCreationSelectionSession; storyId: string; refreshKey?: unknown;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const insets = useSafeAreaInsets();
  useEffect(() => {
    const refresh = () => { void session.refresh(storyId).catch(() => undefined); };
    refresh(); return subscribeTheaterCoCreation(refresh);
  }, [session, storyId, refreshKey]);
  const material = session.material(), length = material ? theaterMaterialLength(material) : 0;
  const paragraphs = state.source ? theaterCheckpointParagraphs(state.source) : [];
  const sentences = state.source ? theaterCoCreationSentences(state.source) : [];
  const selected = (versionId: string, start: number) => state.selection?.lines.some(l => l.versionId === versionId && l.start === start) ?? false;
  return <>
    {!!state.pending && <View><Text>{copy.long}</Text><Button title={copy.title} onPress={() => { void session.open().catch(() => undefined); }} /></View>}
    <Modal visible={state.visible} transparent animationType="none" onRequestClose={() => session.close()}>
      <View style={[styles.scrim, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12,
        paddingLeft: insets.left + 16, paddingRight: insets.right + 16 }]}>
        <View style={styles.panel} accessibilityViewIsModal>
          <Text accessibilityRole="header">{copy.title}</Text><Text>{copy.scope}</Text>
          {!!state.notice && <Text accessibilityRole="alert">{copy[state.notice]}</Text>}
          {state.notice !== 'gone' && <>
            <Text>{`已选 ${length}／2000 字`}</Text>
            {length > THEATER_CREATION_BUDGET && <Text>{`还需减少 ${length - THEATER_CREATION_BUDGET} 字`}</Text>}
            <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
              {!!paragraphs.length && <Text>前情小抄</Text>}
              {paragraphs.map((paragraph, index) => <Pressable key={index} accessibilityRole="checkbox"
                accessibilityState={{ checked: state.selection?.checkpointParagraphs.includes(index), disabled: state.busy }}
                disabled={state.busy} style={[styles.choice, !state.selection?.checkpointParagraphs.includes(index) && styles.disabled]}
                onPress={() => session.toggleParagraph(index)}><Text>{paragraph}</Text></Pressable>)}
              <Text>本次新台词</Text>
              {sentences.map((sentence, index) => <Pressable key={`${sentence.versionId}:${sentence.start}`}
                accessibilityRole="checkbox" accessibilityState={{ checked: selected(sentence.versionId, sentence.start), disabled: state.busy }}
                disabled={state.busy} style={[styles.choice, !selected(sentence.versionId, sentence.start) && styles.disabled]}
                onPress={() => session.toggleLine(index)}>
                <Text>{`${state.source?.names?.[sentence.subject] ?? (sentence.subject === 'I' ? '白云小姐' : '小仓鼠')}：${sentence.content}`}</Text>
              </Pressable>)}
              {!!material && <Text selectable>{material}</Text>}
            </ScrollView>
          </>}
          <View style={styles.actions}>
            <Button title={state.notice === 'gone' ? '返回' : '取消'} disabled={state.busy} onPress={() => session.close()} />
            {state.notice === 'changed' ? <Button title="重新选择" onPress={() => { void session.reselect().catch(() => undefined); }} />
              : state.notice !== 'gone' && <Button title={state.notice === 'failed' ? '重试' : '确认使用'}
                disabled={state.busy || length > THEATER_CREATION_BUDGET} onPress={() => { void session.confirm(); }} />}
          </View>
        </View>
      </View>
    </Modal>
  </>;
}
const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.22)', justifyContent: 'center' },
  panel: { maxHeight: '94%', borderRadius: 20, padding: 16, gap: 12, backgroundColor: colors.cardStrong },
  scroll: { flexShrink: 1 }, content: { gap: 12, paddingBottom: 12 },
  choice: { padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 12 },
  button: { paddingHorizontal: 14, paddingVertical: 12, minHeight: 44 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end' }, disabled: { opacity: 0.45 },
});
