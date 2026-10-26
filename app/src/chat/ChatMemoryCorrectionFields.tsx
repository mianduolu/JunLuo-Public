import { useRef, useState } from 'react';
import { View } from 'react-native';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { styles } from '../screens/ChatScreen.styles';
import { amendMemoryCorrectionConfirmation } from '../tools/memoryCorrection';
import { getToolAgentFrozenProposalInput } from '../tools/toolAgentFrozenProposal';
import type { JunLuoToolAgentConfirmationPresentation } from '../tools/toolAgentFrozenProposal';

type Props = {
  proposalId: string;
  presentation: JunLuoToolAgentConfirmationPresentation;
  editable?: boolean;
  onProposalAdjusted: (proposalId: string, presentation: JunLuoToolAgentConfirmationPresentation) => void;
};

export function ChatMemoryCorrectionFields({ proposalId, presentation, editable = true, onProposalAdjusted }: Props) {
  const fieldValue = (label: string) => presentation.fields.find((field) => field.label === label)?.value ?? '';
  const [draft, setDraft] = useState(() => ({
    title: fieldValue('新标题'), content: fieldValue('新正文'), eventTimeText: fieldValue('新发生时间'),
    tagsText: fieldValue('新标签'), recallCuesText: fieldValue('新回想线索'), rememberedReason: fieldValue('新记住的理由'),
  }));
  const currentDraft = useRef(draft);
  const timeEdited = useRef(false);
  const editedFields = useRef(new Set<keyof typeof draft>());
  const edit = (field: keyof typeof draft, value: string) => {
    if (!editable || !getToolAgentFrozenProposalInput(proposalId)) return;
    const next = { ...currentDraft.current, [field]: value };
    if (field === 'eventTimeText') timeEdited.current = true;
    editedFields.current.add(field);
    const amended = amendMemoryCorrectionConfirmation({
      proposalId, title: next.title, content: next.content,
      ...(editedFields.current.has('tagsText') ? { tagsText: next.tagsText } : {}),
      ...(editedFields.current.has('recallCuesText') ? { recallCuesText: next.recallCuesText } : {}),
      ...(editedFields.current.has('rememberedReason') ? { rememberedReason: next.rememberedReason } : {}),
      ...(timeEdited.current ? { eventTimeText: next.eventTimeText } : {}),
    });
    if (amended) {
      currentDraft.current = next;
      setDraft(next);
      onProposalAdjusted(amended.proposalId, amended.presentation);
    }
  };
  return (
    <View style={styles.toolCallPreview}>
      {presentation.summary ? <Text style={styles.toolCallSummary}>{presentation.summary}</Text> : null}
      <Text style={styles.toolCallPreviewText}>原标题：{fieldValue('原标题')}</Text>
      <Text style={styles.toolCallPreviewText}>原正文：{fieldValue('原正文')}</Text>
      <Text style={styles.toolCallPreviewText}>原发生时间：{fieldValue('原发生时间') || '时间未确定'}</Text>
      <Text style={styles.toolCallPreviewText}>本次依据：{fieldValue('本次依据')}</Text>
      <Text style={styles.toolCallPreviewText}>新标题</Text>
      <TextInput
        editable={editable}
        accessibilityLabel="新标题"
        multiline
        scrollEnabled={false}
        style={[styles.candidateInput, { height: 'auto', minHeight: 34, textAlignVertical: 'top' }]}
        value={draft.title}
        onChangeText={(value) => edit('title', value)}
      />
      <Text style={styles.toolCallPreviewText}>新正文</Text>
      <TextInput
        editable={editable}
        accessibilityLabel="新正文"
        multiline
        scrollEnabled={false}
        style={[styles.candidateInput, { height: 'auto', minHeight: 68, textAlignVertical: 'top' }]}
        value={draft.content}
        onChangeText={(value) => edit('content', value)}
      />
      <Text style={styles.toolCallPreviewText}>新发生时间</Text>
      <TextInput
        editable={editable}
        accessibilityLabel="新发生时间"
        multiline
        scrollEnabled={false}
        style={[styles.candidateInput, { height: 'auto', minHeight: 34, textAlignVertical: 'top' }]}
        value={draft.eventTimeText}
        onChangeText={(value) => edit('eventTimeText', value)}
      />
      <Text style={styles.toolCallPreviewText}>可填写日期或时间说法；清空表示日期未确定。修改日期时，也请核对正文里的时间。</Text>
      {([
        ['tagsText', '原标签', '新标签'],
        ['recallCuesText', '原回想线索', '新回想线索'],
        ['rememberedReason', '原记住的理由', '新记住的理由'],
      ] as const).map(([field, originalLabel, label]) => (
        <View key={field}>
          <Text style={styles.toolCallPreviewText}>{originalLabel}：{fieldValue(originalLabel) || '无'}</Text>
          <Text style={styles.toolCallPreviewText}>{label}</Text>
          <TextInput
            editable={editable}
            accessibilityLabel={label}
            multiline
            scrollEnabled={false}
            style={[styles.candidateInput, { height: 'auto', minHeight: 34, textAlignVertical: 'top' }]}
            value={draft[field]}
            onChangeText={(value) => edit(field, value)}
          />
        </View>
      ))}
      <Text style={styles.toolCallPreviewText}>标签和回想线索可用逗号、顿号或空格分隔；清空表示删除。</Text>
    </View>
  );
}
