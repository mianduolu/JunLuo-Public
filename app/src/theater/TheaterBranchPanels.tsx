import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { colors } from '../theme/colors';

type PanelProps = { visible: boolean; busy?: boolean; onRequestClose: () => void };

function Button({ label, onPress, disabled = false, danger = false }: {
  label: string; onPress: () => void; disabled?: boolean; danger?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}
    disabled={disabled} onPress={onPress} style={[styles.button, danger && styles.dangerButton, disabled && styles.disabled]}>
    <Text style={[styles.buttonText, danger && styles.dangerText]}>{label}</Text>
  </Pressable>;
}

// No editor/selection state lives in the modal: Android back and backdrop taps
// ask the owner to close, so the owner's discard-confirmation keeps its buffer.
function Panel({ visible, onRequestClose, children, bottom = false, keyboard = false }: PanelProps & {
  children: ReactNode; bottom?: boolean; keyboard?: boolean;
}) {
  const insets = useSafeAreaInsets();
  return <Modal transparent visible={visible} animationType="none" onRequestClose={onRequestClose}>
    <KeyboardAvoidingView enabled={keyboard} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={[styles.scrim, bottom && styles.bottom, { paddingTop: insets.top + 12,
        paddingBottom: insets.bottom + 12, paddingLeft: insets.left + 18, paddingRight: insets.right + 18 }]}>
      <Pressable accessible={false} style={StyleSheet.absoluteFillObject} onPress={onRequestClose} />
      <View accessibilityViewIsModal style={styles.panel}>{children}</View>
    </KeyboardAvoidingView>
  </Modal>;
}

export type TheaterBranchListItem = {
  id: string; name: string; ordinal: number; forkLabel?: string; continuedAtLabel?: string;
};

export type TheaterBranchSheetProps = PanelProps & {
  branches: readonly TheaterBranchListItem[]; currentBranchId: string;
  onSwitch: (id: string) => void; onRename: (id: string) => void; onDeleteCurrent: () => void;
};

export function TheaterBranchSheet(props: TheaterBranchSheetProps) {
  return <Panel visible={props.visible} onRequestClose={props.onRequestClose} bottom>
    <Text accessibilityRole="header" style={styles.heading}>剧情走向</Text>
    <ScrollView style={styles.scroll} contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
      {props.branches.map(branch => <View key={branch.id} style={styles.branch}>
        <Text style={styles.label}>{branch.name} · {branch.ordinal}/{props.branches.length}</Text>
        {!!branch.forkLabel && <Text style={styles.muted}>{branch.forkLabel}</Text>}
        {!!branch.continuedAtLabel && <Text style={styles.muted}>{branch.continuedAtLabel}</Text>}
        {branch.id === props.currentBranchId
          ? <Text style={styles.current}>当前走向</Text>
          : <Button label="切换到这条走向" disabled={props.busy} onPress={() => props.onSwitch(branch.id)} />}
        <Button label="更改走向名称" disabled={props.busy} onPress={() => props.onRename(branch.id)} />
      </View>)}
    </ScrollView>
    <View style={styles.deleteRow}>
      <Button label="删除当前走向" danger disabled={props.busy || !props.branches.some(b => b.id === props.currentBranchId)}
        onPress={props.onDeleteCurrent} />
    </View>
  </Panel>;
}

export type TheaterMessageSheetProps = PanelProps & {
  subject: 'I' | 'you';
  notice?: string;
  sentAt?: string; onRead?: () => void;
  destructiveLabel?: '删除' | '删除这个版本' | '从当前走向移除' | '从这句之前继续';
  onCopy: () => void; onEdit: () => void; onRegenerate?: () => void; onDestructive: () => void; onAnchor?: () => void;
};

export function TheaterMessageSheet(props: TheaterMessageSheetProps) {
  return <Panel visible={props.visible} onRequestClose={props.onRequestClose} bottom>
    <ScrollView style={styles.scroll} contentContainerStyle={styles.list}>
      {!!props.sentAt && <Text style={styles.muted}>{`发送时间：${props.sentAt}`}</Text>}
      {!!props.onRead && <Button label="专心阅读" onPress={props.onRead} />}
      <Button label="复制" onPress={props.onCopy} />
      {!!props.notice && <Text style={styles.muted}>{props.notice}</Text>}
      <Button label="编辑台词" disabled={props.busy} onPress={props.onEdit} />
      {!!props.onAnchor && <Button label="设为剧情锚点" disabled={props.busy} onPress={props.onAnchor} />}
      {props.subject === 'I' && !!props.onRegenerate &&
        <Button label="重演" disabled={props.busy} onPress={props.onRegenerate} />}
    </ScrollView>
    {!!props.destructiveLabel && <View style={styles.deleteRow}>
      <Button label={props.destructiveLabel} danger={props.destructiveLabel !== '从这句之前继续'}
        disabled={props.busy} onPress={props.onDestructive} />
    </View>}
  </Panel>;
}

export type TheaterBranchEditorProps = PanelProps & {
  kind: 'message' | 'name'; value: string; hint?: string; error?: string;
  saveLabel?: '保存修改' | '保存并新开走向' | '保存名称' | '重试保存' | '重新查看'; saveDisabled?: boolean;
  onChangeText: (value: string) => void; onSave: () => void;
};

export function TheaterBranchEditor(props: TheaterBranchEditorProps) {
  const message = props.kind === 'message';
  const title = message ? '编辑台词' : '更改走向名称';
  const blank = !props.value.trim();
  const error = blank ? (message ? '台词不能留空。想删掉这句，请使用「删除」。' : '请填写走向名称。') : props.error;
  return <Panel visible={props.visible} onRequestClose={props.onRequestClose} keyboard>
    <Text accessibilityRole="header" style={styles.heading}>{title}</Text>
    <ScrollView style={styles.scroll} contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
      {!!props.hint && <Text style={styles.muted}>{props.hint}</Text>}
      {!message && <Text style={styles.label}>走向名称</Text>}
      <TextInput accessibilityLabel={message ? title : '走向名称'} autoFocus value={props.value}
        onChangeText={props.onChangeText} editable={!props.busy} multiline={message}
        textAlignVertical={message ? 'top' : 'center'} style={[styles.input, message && styles.multiline]} />
      {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    </ScrollView>
    <View style={styles.buttons}>
      <Button label="取消" onPress={props.onRequestClose} />
      <Button label={props.saveLabel ?? (message ? '保存修改' : '保存名称')}
        disabled={props.busy || props.saveDisabled || blank} onPress={props.onSave} />
    </View>
  </Panel>;
}

export type TheaterBranchConfirmationProps = PanelProps & {
  title: string; body: string; confirmLabel: '删除' | '移除' | '新开' | '放弃修改';
  cancelLabel?: '取消' | '继续编辑'; error?: string; onReview?: () => void;
  retryLabel?: '重试' | '重试保存';
  choices?: readonly { id: string; label: string; content: string }[];
  selectedChoiceId?: string | null; onSelectChoice?: (id: string) => void; onConfirm: () => void;
};

export function TheaterBranchConfirmation(props: TheaterBranchConfirmationProps) {
  const choices = props.choices ?? [];
  const choiceMissing = choices.length > 0 && !choices.some(choice => choice.id === props.selectedChoiceId);
  return <Panel visible={props.visible} onRequestClose={props.onRequestClose}>
    <Text accessibilityRole="header" style={styles.heading}>{props.title}</Text>
    <ScrollView style={styles.scroll} contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
      <Text style={styles.body}>{props.body}</Text>
      {choices.map(choice => <Pressable key={choice.id} accessibilityRole="radio"
        accessibilityLabel={choice.label} accessibilityState={{ checked: choice.id === props.selectedChoiceId, disabled: !!props.busy }}
        disabled={props.busy} onPress={() => props.onSelectChoice?.(choice.id)}
        style={[styles.branch, choice.id === props.selectedChoiceId && styles.selected]}>
        <Text style={styles.label}>{choice.id === props.selectedChoiceId ? '●' : '○'} {choice.label}</Text>
        <Text selectable style={styles.body}>{choice.content}</Text>
      </Pressable>)}
      {!!props.error && <Text accessibilityRole="alert" style={styles.error}>{props.error}</Text>}
      {!!props.onReview && <Button label="重新查看" disabled={props.busy} onPress={props.onReview} />}
    </ScrollView>
    <View style={styles.buttons}>
      <Button label={props.cancelLabel ?? '取消'} onPress={props.onRequestClose} />
      <Button label={props.retryLabel ?? props.confirmLabel} danger={props.confirmLabel !== '新开'}
        disabled={props.busy || choiceMissing || !!props.onReview} onPress={props.onConfirm} />
    </View>
  </Panel>;
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(30,40,55,0.3)', justifyContent: 'center' },
  bottom: { justifyContent: 'flex-end' },
  panel: { maxHeight: '100%', padding: 18, borderRadius: 20, backgroundColor: colors.cream, gap: 14 },
  scroll: { flexShrink: 1 },
  list: { gap: 12 },
  heading: { fontSize: 20, fontWeight: '700', color: colors.ink, flexShrink: 1 },
  label: { fontSize: 15, fontWeight: '600', color: colors.ink },
  muted: { fontSize: 13, lineHeight: 21, color: colors.muted },
  current: { fontSize: 13, color: colors.ink },
  body: { fontSize: 15, lineHeight: 23, color: colors.ink },
  branch: { padding: 14, gap: 8, borderRadius: 16, backgroundColor: colors.card },
  selected: { backgroundColor: colors.secondary },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: 14, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  buttonText: { fontSize: 14, color: colors.ink },
  deleteRow: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 12, alignSelf: 'stretch' },
  dangerButton: { borderColor: 'rgba(168,68,58,0.24)' },
  dangerText: { color: '#A8443A' },
  disabled: { opacity: 0.5 },
  input: { minHeight: 46, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 15, lineHeight: 23, color: colors.ink, backgroundColor: colors.cardStrong, borderWidth: 1, borderColor: colors.border },
  multiline: { minHeight: 140 },
  error: { fontSize: 13, color: '#A8443A', lineHeight: 20 },
});
