import { useEffect, useSyncExternalStore } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText as Text } from '../components/AppText';
import { colors } from '../theme/colors';
import { TheaterBranchHistory, TheaterBranchWorkspace } from './TheaterBranchWorkspace';
import type { TheaterFeatureRuntime } from './theaterFeatureRuntime';
import type { TheaterFeatureController } from './useTheaterFeature';

function ReadyFeature({ runtime, onOpenFeatureDrawer }: {
  runtime: TheaterFeatureRuntime & Pick<NonNullable<TheaterFeatureController['runtime']>, 'coCreation'>;
  onOpenFeatureDrawer?: () => void;
}) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const setupState = useSyncExternalStore(runtime.setup.subscribe, runtime.setup.getSnapshot);
  const insets = useSafeAreaInsets();
  const title = setupState.stories.find(story => story.id === state.storyId)?.title ?? '小剧场';
  const leave = () => runtime.setup.requestLeave(() => onOpenFeatureDrawer?.());
  return <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.root}>
    <View style={[styles.header, { paddingTop: Math.max(14, insets.top + 8) }]}>
      {onOpenFeatureDrawer && <Pressable accessibilityRole="button" onPress={leave} style={styles.action}>
        <Text style={styles.text}>☰</Text>
      </Pressable>}
      <View style={styles.root}>
        <Text style={styles.small}>与你 · 小剧场</Text>
        <Text numberOfLines={1} style={styles.title}>{title}</Text>
      </View>
      <Pressable accessibilityRole="button" onPress={() => runtime.setup.newStory()} style={styles.action}>
        <Text style={styles.text}>新建</Text>
      </Pressable>
    </View>
    <View style={styles.tabs}>
      {(['chat', 'setup', 'history'] as const).map(tab => <Pressable key={tab} accessibilityRole="button"
        accessibilityState={{ selected: state.tab === tab }} onPress={() => runtime.selectTab(tab)}
        style={[styles.tab, state.tab === tab && styles.selected]}>
        <Text style={[styles.small, state.tab === tab && styles.selectedText]}>
          {{ chat: '对话', setup: '设定', history: '历史' }[tab]}
        </Text>
      </Pressable>)}
    </View>
    {state.tab === 'chat' && state.storyId
      ? <TheaterBranchWorkspace storyId={state.storyId} session={runtime.branches}
        generation={runtime.generation} drafts={runtime.drafts} summaries={runtime.summaries}
        anchors={runtime.anchors} reading={runtime.reading} search={runtime.search}
        coCreation={runtime.coCreation} backstage={runtime.backstage}
        onOpenStory={runtime.openStory} onOpenSettings={() => runtime.selectTab('setup')} />
      : <TheaterBranchHistory setup={runtime.setup} session={runtime.branches}
        generation={runtime.generation} history={runtime.history} onLeave={leave} embedded />}
  </KeyboardAvoidingView>;
}

export function TheaterFeature({ controller, active = true, onOpenFeatureDrawer }: {
  controller: TheaterFeatureController; active?: boolean; onOpenFeatureDrawer?: () => void;
}) {
  useEffect(() => {
    controller.setVisible(active);
    if (active) controller.activate();
    return () => controller.setVisible(false);
  }, [active, controller.activate, controller.setVisible]);
  // Unmount view-local modals/back handlers when hidden; sessions stay in App.
  if (!active) return null;
  if (controller.runtime) return <ReadyFeature runtime={controller.runtime} onOpenFeatureDrawer={onOpenFeatureDrawer} />;
  return <View style={styles.loading}>
    <Text style={styles.small}>{controller.error ? '暂时没能读到小剧场' : '正在读取…'}</Text>
    {controller.error && <Pressable accessibilityRole="button" onPress={controller.activate} style={styles.action}>
      <Text style={styles.text}>重试</Text>
    </Pressable>}
    {onOpenFeatureDrawer && <Pressable accessibilityRole="button" onPress={onOpenFeatureDrawer} style={styles.action}>
      <Text style={styles.text}>☰</Text>
    </Pressable>}
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1 }, loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { alignItems: 'center', flexDirection: 'row', gap: 12, paddingHorizontal: 12 },
  action: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center' },
  title: { color: colors.ink, fontSize: 17, fontWeight: '700' },
  text: { color: colors.ink, fontSize: 13 }, small: { color: colors.muted, fontSize: 13 },
  tabs: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingVertical: 12 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.58)', borderWidth: 1, borderColor: colors.border },
  selected: { backgroundColor: colors.primary, borderColor: colors.primary },
  selectedText: { color: '#FFFFFF' },
});
