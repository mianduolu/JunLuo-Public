import { useCallback, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppText as Text } from '../components/AppText';
import { BaiyunPostCard, type PostCommentInputState } from './BaiyunPostCard';
import { postStyles as s } from './baiyunPostStyles';
import { postNoticeKey } from './baiyunPostNotice';
import { PostNoticeViewportContext, usePostNoticeViewport } from './BaiyunPostNoticeViewport';

export function BaiyunPostDetail({ card, onClose, covered, children, noticeSource, onInputStateChange }: {
  card: ComponentProps<typeof BaiyunPostCard> | null; onClose: () => void; covered: boolean; children?: ReactNode; noticeSource?: string | null;
  onInputStateChange?: (state: PostCommentInputState) => void;
}) {
  const [input, setInput] = useState<PostCommentInputState>({ hasDraft: false, busy: false });
  const updateInput = useCallback((state: PostCommentInputState) => {
    setInput(state); onInputStateChange?.(state);
  }, [onInputStateChange]);
  const [shown, setShown] = useState(false);
  const scroll = useRef<ScrollView>(null);
  const viewport = usePostNoticeViewport(shown && !covered, scroll,
    card && noticeSource !== undefined && (noticeSource === null ? card.post.author === 'I'
      : card.comments.some(comment => comment.source === noticeSource && !comment.deleted))
      ? postNoticeKey(card.post.id, noticeSource) : undefined);
  const close = (afterClose?: () => void) => {
    if (card && input.busy) return;
    const finish = () => { onClose(); afterClose?.(); };
    if (card && input.hasDraft) {
      Alert.alert('放弃这条未发送的评论？', '正文和已选图片会清空。', [
        { text: '继续编辑', style: 'cancel' }, { text: '放弃', style: 'destructive', onPress: finish },
      ]);
    } else finish();
  };
  return <Modal animationType="slide" onShow={() => setShown(true)} onRequestClose={() => close()}>
    <PostNoticeViewportContext.Provider value={viewport.context}>
    <SafeAreaView style={s.page}>
      <View style={s.header}>
        <Pressable style={s.button} disabled={Boolean(card && input.busy)} onPress={() => close()}><Text style={s.link}>返回</Text></Pressable>
        <Text style={s.heading}>动态详情</Text>
      </View>
      <KeyboardAvoidingView style={s.grow} enabled={Platform.OS === 'ios' && !covered} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView ref={scroll} style={s.grow} scrollEnabled={!input.busy} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={[s.list, { paddingTop: 16 }]}
          onScroll={viewport.onScroll} scrollEventThrottle={32} onLayout={viewport.changed} onContentSizeChange={viewport.changed}>
          {card ? <BaiyunPostCard {...card} detail initialCommentSource={noticeSource ?? undefined} onCommentStateChange={updateInput} onTag={id => close(() => card.onTag(id))} />
            : <Text style={[s.muted, s.section]}>这条动态已删除。</Text>}
        </ScrollView>
      </KeyboardAvoidingView>
      {children}
    </SafeAreaView>
    </PostNoticeViewportContext.Provider>
  </Modal>;
}
