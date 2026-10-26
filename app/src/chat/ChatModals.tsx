import {
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  View,
} from 'react-native';

import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { styles } from '../screens/ChatScreen.styles';
import { colors } from '../theme/colors';
import { ChatMemoryRecallModal, type ChatMemoryRecallModalProps } from './ChatMemoryRecallModal';
import { ChatTokenDetailsModal, type ChatTokenDetailsModalProps } from './ChatTokenDetailsModal';
import { formatMessageTime } from './chatMessageDisplay';

type ImagePreviewGroup = {
  onClose: () => void;
  uri: string | null;
};

type MessageEditGroup = {
  onChangeText: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
  text: string;
  visible: boolean;
};

type OrganizationGroup = {
  messages: SubjectiveMessage[] | null;
  mode: 'new' | 'selected';
  onClose: () => void;
  onConfirm: () => void;
};

type LegacySelectionGroup = {
  messages: SubjectiveMessage[];
  onClose: () => void;
  onConfirm: () => void;
  onToggleMessage: (messageId: string) => void;
  selectedMessageIds: string[];
};

type ChatModalsProps = {
  imagePreview: ImagePreviewGroup;
  legacySelection: LegacySelectionGroup;
  memoryRecall: ChatMemoryRecallModalProps;
  messageEdit: MessageEditGroup;
  organization: OrganizationGroup;
  tokenDetails: ChatTokenDetailsModalProps;
};

export function ChatModals({
  imagePreview,
  legacySelection,
  memoryRecall,
  messageEdit,
  organization,
  tokenDetails,
}: ChatModalsProps) {
  return (
    <>
      <ImagePreviewModal {...imagePreview} />
      <ChatTokenDetailsModal {...tokenDetails} />
      <MessageEditModal {...messageEdit} />
      <ChatMemoryRecallModal {...memoryRecall} />
      <OrganizationModal {...organization} />
    </>
  );
}

function ImagePreviewModal({ onClose, uri }: ImagePreviewGroup) {
  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={!!uri}>
      <View style={styles.imagePreviewBackdrop}>
        <Pressable accessibilityLabel="关闭图片预览" onPress={onClose} style={styles.imagePreviewClose}>
          <Text style={styles.imagePreviewCloseText}>×</Text>
        </Pressable>
        {uri ? <Image resizeMode="contain" source={{ uri }} style={styles.imagePreviewImage} /> : null}
      </View>
    </Modal>
  );
}

function MessageEditModal({
  onChangeText,
  onClose,
  onSave,
  text,
  visible,
}: MessageEditGroup) {
  const saveDisabled = !text.trim();
  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.renameLayer}
      >
        <Pressable onPress={onClose} style={styles.renameScrim} />
        <View style={styles.editMessagePanel}>
          <Text style={styles.renameHeading}>修改白云小姐的话</Text>
          <Text style={styles.editMessageHint}>保存后，这段对话接下来会以修正后的内容继续。</Text>
          <TextInput
            autoFocus
            multiline
            onChangeText={onChangeText}
            style={styles.editMessageInput}
            textAlignVertical="top"
            value={text}
          />
          <View style={styles.renameActions}>
            <Pressable onPress={onClose} style={styles.renameCancel}>
              <Text style={styles.renameCancelText}>取消</Text>
            </Pressable>
            <Pressable
              disabled={saveDisabled}
              onPress={onSave}
              style={[styles.renameSave, saveDisabled && styles.editMessageSaveDisabled]}
            >
              <Text style={styles.renameSaveText}>保存编辑</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function OrganizationModal({ messages, mode, onClose, onConfirm }: OrganizationGroup) {
  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={!!messages}>
      <View style={styles.rangeLayer}>
        <Pressable onPress={onClose} style={styles.renameScrim} />
        {messages ? (
          <View style={styles.rangePanel}>
            <Text style={styles.rangeHeading}>这次整理哪些回忆？</Text>
            <Text style={styles.rangeDescription}>
              {mode === 'selected'
                ? '整理勾选的消息，不影响聊天整理进度；有待整理信件时，同批最多带一段。'
                : '整理尚未处理的聊天；有待整理信件时，同批最多带一段。'}
            </Text>
            {mode === 'selected' ? <Text style={styles.rangeDescription}>
              每批最多三十条材料，每批一次请求；中途可以停止，未完成范围会保留。
            </Text> : null}
            <View style={styles.rangeStats}>
              <View style={styles.rangeStat}>
                <Text style={styles.rangeStatNumber}>{messages.length}</Text>
                <Text style={styles.rangeStatLabel}>条新消息</Text>
              </View>
              <View style={styles.rangeStat}>
                <Text style={styles.rangeStatNumber}>
                  {messages.filter((message) => message.role === 'you').length}
                </Text>
                <Text style={styles.rangeStatLabel}>小仓鼠</Text>
              </View>
              <View style={styles.rangeStat}>
                <Text style={styles.rangeStatNumber}>
                  {messages.filter((message) => message.role === 'I').length}
                </Text>
                <Text style={styles.rangeStatLabel}>白云小姐</Text>
              </View>
            </View>
            {messages.length ? <Text style={styles.rangeTime}>
              {formatMessageTime(messages[0].createdAt)}
              {' - '}
              {formatMessageTime(messages[messages.length - 1].createdAt)}
            </Text> : <Text style={styles.rangeTime}>检查待整理信件</Text>}
            <View style={styles.rangePreview}>
              <Text numberOfLines={2} style={styles.rangePreviewText}>
                {messages[0] ? `开始：${messages[0].content}` : '没有新聊天，仍可整理已寄出、送达或拆开的信件。'}
              </Text>
              {messages.length > 1 ? (
                <Text numberOfLines={2} style={styles.rangePreviewText}>
                  最后：{messages[messages.length - 1].content}
                </Text>
              ) : null}
            </View>
            <View style={styles.renameActions}>
              <Pressable onPress={onClose} style={styles.renameCancel}>
                <Text style={styles.renameCancelText}>取消</Text>
              </Pressable>
              <Pressable onPress={onConfirm} style={styles.rangeConfirm}>
                <Text style={styles.rangeConfirmText}>开始整理</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

function LegacySelectionModal({
  messages,
  onClose,
  onConfirm,
  onToggleMessage,
  selectedMessageIds,
}: LegacySelectionGroup) {
  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={false}>
      <View style={styles.rangeLayer}>
        <Pressable onPress={onClose} style={styles.renameScrim} />
        <View style={styles.rangePanel}>
          <Text style={styles.rangeHeading}>自选消息整理</Text>
          <Text style={styles.rangeDescription}>勾选真正值得进入记忆本的消息，测试功能和临时试错可以跳过。</Text>
          <View style={styles.rangeStats}>
            <View style={styles.rangeStat}>
              <Text style={styles.rangeStatNumber}>{selectedMessageIds.length}</Text>
              <Text style={styles.rangeStatLabel}>已选消息</Text>
            </View>
            <View style={styles.rangeStat}>
              <Text style={styles.rangeStatNumber}>{messages.length}</Text>
              <Text style={styles.rangeStatLabel}>全部消息</Text>
            </View>
          </View>
          <ScrollView contentContainerStyle={styles.selectionList} style={styles.selectionScroll} showsVerticalScrollIndicator={false}>
            {messages.map((message) => {
              const selected = selectedMessageIds.includes(message.id);
              return (
                <Pressable
                  key={message.id}
                  onPress={() => onToggleMessage(message.id)}
                  style={[styles.selectionItem, selected && styles.selectionItemSelected]}
                >
                  <View style={styles.selectionItemTop}>
                    <Text style={styles.selectionRole}>{message.role === 'you' ? '小仓鼠' : '白云小姐'}</Text>
                    <Text style={styles.selectionTime}>{formatMessageTime(message.createdAt)}</Text>
                  </View>
                  <Text numberOfLines={3} style={styles.selectionText}>{message.content}</Text>
                  <Text style={selected ? styles.selectionPicked : styles.selectionPick}>
                    {selected ? '已勾选' : '点按勾选'}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
          <View style={styles.renameActions}>
            <Pressable onPress={onClose} style={styles.renameCancel}>
              <Text style={styles.renameCancelText}>取消</Text>
            </Pressable>
            <Pressable
              disabled={!selectedMessageIds.length}
              onPress={onConfirm}
              style={[styles.rangeConfirm, !selectedMessageIds.length && styles.disabledButton]}
            >
              <Text style={styles.rangeConfirmText}>整理已选</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
