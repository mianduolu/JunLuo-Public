import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import type { PostCommentData, PostData } from './baiyunPostData';
import { discardPostDraft, emptyPostDraft, loadPostDraft, POST_DRAFT_IMAGE_KEY, savePostDraft, type PostDraft } from './baiyunPostDraft';
import { revisePostImageGroup } from './baiyunPostImageData';
import { collectUnusedPostImages } from './baiyunPostImageFiles';
import { createLocalBaiyunPost, editLocalBaiyunPost, editLocalBaiyunPostComment } from './baiyunPostStore';
import { loadPostTags, tagAllowsAuthor, type PostTag } from './baiyunPostTags';
import { PostImageEditor, PostImages } from './BaiyunPostImages';
import { PostTagPicker } from './BaiyunPostTagsView';
import { postStyles as s } from './baiyunPostStyles';

export type PostEditTarget = { post: PostData; comment?: PostCommentData };
export function BaiyunPostEditor({ target, tags, onClose, onSaved }: {
  target: PostEditTarget | null; tags: PostTag[]; onClose: () => void; onSaved: () => void;
}) {
  const current = target?.comment ?? target?.post;
  const repair = current?.author === 'I';
  const [draft, setDraft] = useState<PostDraft | null>(null);
  const latest = useRef<PostDraft | null>(null);
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  const savingRef = useRef(false);
  const alive = useRef(true);
  const [saving, setSaving] = useState(false);
  const [closing, setClosing] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [pickingTags, setPickingTags] = useState(false);
  const [error, setError] = useState('');
  const [draftError, setDraftError] = useState(false);
  const editKey = useRef(`post-edit-${Date.now()}-${Math.random().toString(36).slice(2)}`).current;
  useEffect(() => {
    alive.current = true;
    void (async () => {
      const initial = current ? { ...emptyPostDraft(), title: target?.comment ? '' : target?.post.title ?? '', content: current.content,
        imageIds: current.imageGroup?.imageIds ?? [], tagIds: target?.comment ? [] : target?.post.tagIds ?? [] }
        : await loadPostDraft() ?? emptyPostDraft();
      if (alive.current) { latest.current = initial; setDraft(initial); }
    })().catch(() => { if (alive.current) setError('草稿读取失败，请返回后重试。'); });
    return () => { alive.current = false; };
  }, []);
  const update = (change: Partial<PostDraft>) => {
    if (!latest.current || savingRef.current) return Promise.resolve();
    const next = { ...latest.current, ...change };
    latest.current = next;
    if (alive.current) setDraft(next);
    if (target) return Promise.resolve();
    // While one write is busy, intermediate keystrokes are superseded by the latest snapshot.
    const task = pending.current.catch(() => undefined).then(() => latest.current === next ? savePostDraft(next) : undefined);
    pending.current = task;
    void task.then(() => { if (alive.current) setDraftError(false); }, () => { if (alive.current) setDraftError(true); });
    return task;
  };
  const close = async () => {
    if (savingRef.current || imageBusy) return;
    savingRef.current = true; setClosing(true); setError('');
    try { await pending.current; onClose(); }
    catch { setError('草稿尚未保存成功，请重试保存后再返回。'); }
    finally { savingRef.current = false; if (alive.current) setClosing(false); }
  };
  const save = async () => {
    const input = latest.current;
    if (!input || savingRef.current || imageBusy || (!input.content.trim() && !input.imageIds.length)) return;
    savingRef.current = true; setSaving(true); setError('');
    try {
      await pending.current.catch(() => undefined);
      const library = await loadPostTags();
      const tagIds = input.tagIds.filter(id => library.some(tag => tag.id === id && tagAllowsAuthor(tag, current?.author ?? 'you')));
      const body = { content: input.content, imageGroup: revisePostImageGroup(current?.imageGroup ?? null, input.imageIds) };
      if (!target) {
        await savePostDraft({ ...input, tagIds });
        await createLocalBaiyunPost({ ...body, title: input.title ?? '', author: 'you', tagIds, consumeDraftId: input.id });
      } else if (target.comment) await editLocalBaiyunPostComment(target.post.id, target.comment.source, body, repair ? 'repair' : 'edit');
      else await editLocalBaiyunPost(target.post.id, { ...body, title: input.title ?? '' }, repair ? 'repair' : 'edit', tagIds);
      // A cleanup failure cannot turn a committed publication into a second publish attempt.
      void collectUnusedPostImages().catch(() => undefined);
      onSaved();
    } catch { if (alive.current) setError('保存失败，内容已保留，请重试。'); }
    finally { savingRef.current = false; if (alive.current) setSaving(false); }
  };
  const discard = () => {
    if (!draft || savingRef.current || imageBusy) return;
    Alert.alert('丢弃草稿？', '这份未发布的标题、正文、图片和标签选择会清空。', [{ text: '取消', style: 'cancel' },
      { text: '丢弃', style: 'destructive', onPress: () => {
        savingRef.current = true; setSaving(true);
        void pending.current.catch(() => undefined).then(() => discardPostDraft(draft.id)).then(onClose)
          .catch(() => setError('丢弃失败，请重试。')).finally(() => { savingRef.current = false; if (alive.current) setSaving(false); });
      } }]);
  };
  const busy = saving || closing || imageBusy;
  return <Modal animationType="slide" onRequestClose={() => void close()}>
    <SafeAreaView style={[s.page, s.editorPage]}>
      <View style={s.header}><Pressable disabled={busy} onPress={() => void close()} style={s.button}><Text style={s.link}>返回</Text></Pressable>
        <Text style={[s.heading, s.grow]}>{target ? repair ? '修修' : '编辑' : '发条动态'}</Text>
        <Pressable disabled={busy || !draft || (!draft.content.trim() && !draft.imageIds.length)} onPress={() => void save()} style={[s.button, s.primary, (busy || !draft || (!draft.content.trim() && !draft.imageIds.length)) && s.disabled]}><Text style={s.primaryText}>{saving ? '保存中' : target ? '保存' : '发布'}</Text></Pressable>
      </View>
      {/* Android's modal already uses adjustResize; a second height correction can collapse the scroll area. */}
      <KeyboardAvoidingView style={s.grow} enabled={Platform.OS === 'ios'} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView style={s.grow} scrollEnabled={!imageBusy} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={s.editorContent}>
          {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
          {closing ? <Text style={s.muted}>正在保存草稿…</Text> : null}
          {!draft && !error ? <ActivityIndicator /> : null}
          {draft ? <>
            {!target?.comment ? <TextInput accessibilityLabel="动态标题（选填）" value={draft.title ?? ''}
              onChangeText={title => { void update({ title }).catch(() => undefined); }} editable={!busy}
              placeholder="标题（选填）" style={[s.input, s.editorTitle]} /> : null}
            <TextInput accessibilityLabel={target?.comment ? '评论正文' : '动态正文'} multiline textAlignVertical="top" value={draft.content}
              onChangeText={content => { void update({ content }).catch(() => undefined); }} editable={!busy}
              placeholder="记下这一刻…" style={[s.input, s.editorInput]} />
            {repair ? <PostImages ids={draft.imageIds} /> : <PostImageEditor ids={draft.imageIds} draftKey={target ? editKey : POST_DRAFT_IMAGE_KEY}
              persistent={!target} disabled={saving || closing} onBusy={setImageBusy} beforeImport={() => pending.current.then(() => undefined)}
              onChange={imageIds => update({ imageIds })} />}
            {!target?.comment ? <View style={s.wrap}><Pressable disabled={busy} style={s.button} onPress={() => setPickingTags(true)}><Text style={s.link}>＋ 标签</Text></Pressable>
              {draft.tagIds.map(id => tags.find(tag => tag.id === id)).filter(tag => tag !== undefined).map(tag => <Text key={tag.id} style={s.link}>#{tag.name}</Text>)}
            </View> : null}
            {!target ? <View style={[s.wrap, s.draftFooter]}><Text style={[s.muted, s.grow]}>{draftError ? '草稿保存失败' : '草稿仅保存在本机'}</Text>
              {draftError ? <Pressable disabled={busy} style={s.button} onPress={() => { void update({}).catch(() => undefined); }}><Text style={s.link}>重试保存</Text></Pressable> : null}
              <Pressable disabled={busy} style={s.button} onPress={discard}><Text style={s.muted}>丢弃草稿</Text></Pressable></View> : null}
          </> : null}
        </ScrollView>
      </KeyboardAvoidingView>
      {pickingTags && draft ? <PostTagPicker tags={tags} author={current?.author ?? 'you'} selected={draft.tagIds}
        onChange={tagIds => { void update({ tagIds }).catch(() => undefined); }} onClose={() => setPickingTags(false)} /> : null}
    </SafeAreaView>
  </Modal>;
}
