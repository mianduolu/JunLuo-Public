import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import type { PostCommentData, PostData } from './baiyunPostData';
import { reconcilePostDraftImages } from './baiyunPostDraft';
import { loadLocalBaiyunPostPage, setLocalBaiyunPostTags, subscribeBaiyunPosts } from './baiyunPostStore';
import { loadPostTags, tagAllowsAuthor, type PostTag } from './baiyunPostTags';
import { defaultPostFilter, filterPosts, type PostFilter } from './baiyunPostPresentation';
import { BaiyunPostCard } from './BaiyunPostCard';
import { BaiyunPostDetail } from './BaiyunPostDetail';
import { recoverPostEditorImages } from './BaiyunPostImages';
import { BaiyunPostEditor, type PostEditTarget } from './BaiyunPostEditor';
import { PostTagManager, PostTagPicker } from './BaiyunPostTagsView';
import { postStyles as s } from './baiyunPostStyles';
import { consumePostNoticeOpen, subscribePostNoticeOpen } from './baiyunPostNotice';
import { PostNoticeViewportContext, usePostNoticeViewport } from './BaiyunPostNoticeViewport';
import { BaiyunPostMemoryReview } from './BaiyunPostMemoryReview';

export function BaiyunPostsPanel({ onOpenDrawer, covered = false }: { onOpenDrawer?: () => void; covered?: boolean }) {
  const insets = useSafeAreaInsets();
  const [posts, setPosts] = useState<PostData[]>([]);
  const [comments, setComments] = useState<PostCommentData[]>([]);
  const [tags, setTags] = useState<PostTag[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [initializationError, setInitializationError] = useState('');
  const [filter, setFilter] = useState(defaultPostFilter);
  const [filterOpen, setFilterOpen] = useState(false);
  const [manager, setManager] = useState(false);
  const [editor, setEditor] = useState<{ target: PostEditTarget | null } | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [memoryReviewOpen, setMemoryReviewOpen] = useState(false);
  const [noticeSource, setNoticeSource] = useState<string | null | undefined>(undefined);
  const [noticeVersion, setNoticeVersion] = useState(0);
  const [noticeRequest, setNoticeRequest] = useState('');
  const [noticeMessage, setNoticeMessage] = useState('');
  const [detailInput, setDetailInput] = useState({ hasDraft: false, busy: false });
  const [tagEdit, setTagEdit] = useState<{ post: PostData; ids: string[] } | null>(null);
  const [tagSaving, setTagSaving] = useState(false);
  const [tagError, setTagError] = useState('');
  const tagLock = useRef(false);
  const alive = useRef(false), loadVersion = useRef(0);
  const refreshFlight = useRef<Promise<void> | null>(null), refreshAgain = useRef(false);
  const pageFresh = useRef(false);
  const scroll = useRef<ScrollView>(null), offset = useRef(0), returnOffset = useRef(0);
  const detailOffset = useRef(0);
  const viewport = usePostNoticeViewport(!covered && !detailId && !editor && !manager && !tagEdit && !memoryReviewOpen, scroll);
  const readPage = useCallback(async () => {
    const version = ++loadVersion.current;
    try {
      const [{ posts: next, comments: discussion }, library] = await Promise.all([loadLocalBaiyunPostPage(), loadPostTags()]);
      if (alive.current && version === loadVersion.current) {
        setPosts(next);
        setComments(discussion); setTags(library); setError(''); setLoaded(true);
        pageFresh.current = true;
        setFilter(previous => previous.tag && previous.tag !== '__untagged' && !library.some(tag => tag.id === previous.tag)
          ? { ...previous, tag: '' } : previous);
      }
    } catch { if (alive.current && version === loadVersion.current) { pageFresh.current = false; setError('动态读取失败，请刷新重试。'); setLoaded(true); } }
  }, []);
  const refresh = useCallback((changed = false): Promise<void> => {
    if (changed) pageFresh.current = false;
    if (refreshFlight.current) {
      if (changed) refreshAgain.current = true;
      return refreshFlight.current;
    }
    // Writes notify at commit; their later completion only joins that refresh.
    if (pageFresh.current) return Promise.resolve();
    const task = Promise.resolve().then(async () => {
      do { refreshAgain.current = false; await readPage(); }
      while (alive.current && refreshAgain.current);
    }).finally(() => { refreshFlight.current = null; });
    refreshFlight.current = task;
    return task;
  }, [readPage]);
  const initialize = useCallback(async () => {
    let stage = 'draft-image-references';
    let draftReady = false;
    if (alive.current) setInitializationError('');
    try {
      await reconcilePostDraftImages();
      draftReady = true;
      stage = 'editor-image-recovery';
      await recoverPostEditorImages();
    } catch (cause) {
      console.warn('[baiyun-post-initialize]', stage, cause instanceof Error ? cause.message : String(cause));
      if (alive.current) setInitializationError(draftReady
        ? '临时图片整理未完成，下次打开时重试。不影响查看或发布动态。'
        : '本地草稿准备未完成，暂时无法发布。已有内容保留，请刷新重试。');
    }
    if (alive.current) setReady(draftReady);
    // Draft readiness gates publication, not reading already published posts.
    await refresh(true);
  }, [refresh]);
  useEffect(() => {
    alive.current = true;
    const unsubscribe = subscribeBaiyunPosts(() => { void refresh(true); });
    void initialize();
    return () => { alive.current = false; unsubscribe(); };
  }, [initialize, refresh]);
  useEffect(() => subscribePostNoticeOpen(() => {
    setNoticeVersion(value => value + 1);
    void refresh(true);
  }), [refresh]);
  useEffect(() => {
    if (!loaded || error || !pageFresh.current || covered || editor || tagEdit || manager || memoryReviewOpen || detailInput.hasDraft || detailInput.busy) return;
    const target = consumePostNoticeOpen();
    if (!target) return;
    if (!posts.some(post => post.id === target.postId)) {
      setDetailId(null); setNoticeMessage('这条动态已删除'); return;
    }
    const source = target.commentSource && comments.some(comment => comment.postId === target.postId
      && comment.source === target.commentSource && !comment.deleted) ? target.commentSource : null;
    if (!detailId) detailOffset.current = offset.current;
    setNoticeMessage(''); setNoticeRequest(target.requestId ?? '');
    setNoticeSource(source); setDetailId(target.postId);
  }, [loaded, error, posts, comments, noticeVersion, editor, tagEdit, manager, memoryReviewOpen, detailInput, detailId, covered]);
  const openEditor = useCallback((target: PostEditTarget | null) => { returnOffset.current = offset.current; setEditor({ target }); }, []);
  const closeEditor = () => { setEditor(null); requestAnimationFrame(() => scroll.current?.scrollTo({ y: returnOffset.current, animated: false })); };
  const openDetail = useCallback((id: string) => { detailOffset.current = offset.current; setNoticeSource(undefined); setDetailId(id); }, []);
  const closeDetail = () => { setDetailId(null); setDetailInput({ hasDraft: false, busy: false }); requestAnimationFrame(() => scroll.current?.scrollTo({ y: detailOffset.current, animated: false })); };
  const setPart = useCallback((change: Partial<PostFilter>) => setFilter(previous => ({ ...previous, ...change })), []);
  const selectTag = useCallback((tag: string) => {
    setPart({ tag }); setFilterOpen(true);
    requestAnimationFrame(() => scroll.current?.scrollTo({ y: 0, animated: true }));
  }, [setPart]);
  const openTagEditor = useCallback((post: PostData) => { setTagError(''); setTagEdit({ post, ids: post.tagIds }); }, []);
  const filtered = useMemo(() => filterPosts(posts, filter), [posts, filter]);
  // Keep the unchanged feed elements while a detail overlay opens or closes.
  const feedCards = useMemo(() => filtered.map(post => <BaiyunPostCard key={post.id} post={post}
    comments={comments.filter(comment => comment.postId === post.id)} tags={tags}
    onOpen={openDetail} onEdit={openEditor} onEditTags={openTagEditor} onTag={selectTag} refresh={refresh} />),
  [filtered, comments, tags, openDetail, openEditor, openTagEditor, selectTag, refresh]);
  const detailPost = posts.find(post => post.id === detailId);
  const saveTags = async () => {
    if (!tagEdit || tagLock.current) return;
    tagLock.current = true; setTagSaving(true); setTagError('');
    try {
      const library = await loadPostTags();
      const ids = tagEdit.ids.filter(id => library.some(tag => tag.id === id && tagAllowsAuthor(tag, tagEdit.post.author)));
      await setLocalBaiyunPostTags(tagEdit.post.id, ids); setTagEdit(null); await refresh();
    } catch { setTagError('标签保存失败，请重试。'); }
    finally { tagLock.current = false; setTagSaving(false); }
  };
  const overlays = <>
    {editor ? <BaiyunPostEditor target={editor.target} tags={tags} onClose={closeEditor} onSaved={() => { closeEditor(); void refresh(); }} /> : null}
    {manager ? <PostTagManager tags={tags} refresh={refresh} onClose={() => setManager(false)} /> : null}
    {tagEdit ? <PostTagPicker tags={tags} author={tagEdit.post.author} selected={tagEdit.ids} disabled={tagSaving} error={tagError}
      onChange={ids => setTagEdit({ ...tagEdit, ids })} onClose={() => void saveTags()} onCancel={() => { if (!tagSaving) setTagEdit(null); }} /> : null}
  </>;
  return <PostNoticeViewportContext.Provider value={viewport.context}><KeyboardAvoidingView style={s.page} enabled={Platform.OS === 'ios' && !editor && !manager && !tagEdit && !detailId && !memoryReviewOpen}
    behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <View style={s.header}>
      {onOpenDrawer ? <Pressable accessibilityLabel="打开往来侧边栏" style={s.button} onPress={onOpenDrawer}><Text style={[s.link, { fontSize: 23 }]}>☰</Text></Pressable> : null}
      <View style={s.grow}><Text style={s.muted}>往来</Text><Text style={s.title}>白云苍狗</Text></View>
      <Pressable accessibilityRole="button" disabled={!ready} style={[s.button, s.primary, !ready && s.disabled]} onPress={() => openEditor(null)}><Text style={s.primaryText}>发布</Text></Pressable>
    </View>
    <ScrollView ref={scroll} keyboardShouldPersistTaps="handled" onScroll={event => { offset.current = event.nativeEvent.contentOffset.y; viewport.onScroll(event); }} scrollEventThrottle={16}
      onLayout={viewport.changed} onContentSizeChange={viewport.changed}
      contentContainerStyle={[s.list, { paddingBottom: Math.max(28, insets.bottom + 20) }]}>
      <View style={s.row}><Text style={[s.muted, s.grow]}>{filter.year || filter.month || filter.author || filter.tag ? '筛选结果' : '全部动态 · 最新在前'}</Text>
        <Pressable onPress={() => setFilterOpen(value => !value)} style={s.button} accessibilityState={{ expanded: filterOpen }}><Text style={s.link}>筛选</Text></Pressable>
        <Pressable onPress={() => setManager(true)} style={s.button}><Text style={s.link}>标签</Text></Pressable>
        <Pressable onPress={() => void (ready ? refresh(true) : initialize())} style={s.button}><Text style={s.link}>刷新</Text></Pressable>
      </View>
      {filterOpen ? <View style={[s.section, { backgroundColor: '#FFFEFD', borderRadius: 16 }]}>
        <View style={s.row}><View style={s.grow}><Text style={s.muted}>年份（留空为全部）</Text><TextInput accessibilityLabel="筛选年份" keyboardType="number-pad" value={filter.year} onChangeText={year => setPart({ year: year.replace(/\D/g, '').slice(0, 4) })} style={[s.input, s.field]} placeholder="全部年份" /></View>
          <View style={s.grow}><Text style={s.muted}>月份（1～12）</Text><TextInput accessibilityLabel="筛选月份" keyboardType="number-pad" value={filter.month} onChangeText={month => { const digits = month.replace(/\D/g, '').slice(0, 2); if (!digits || Number(digits) <= 12) setPart({ month: digits ? String(Number(digits)) : '' }); }} style={[s.input, s.field]} placeholder="全部月份" /></View></View>
        <View style={s.wrap}>{(['', 'you', 'I'] as const).map(author => <Pressable key={author} style={[s.button, filter.author === author && s.selected]} onPress={() => setPart({ author })} accessibilityState={{ selected: filter.author === author }}><Text style={s.link}>{author === 'you' ? '小仓鼠' : author === 'I' ? '白云小姐' : '全部发布人'}</Text></Pressable>)}</View>
        <View style={s.wrap}>{[{ id: '', name: '全部标签' }, { id: '__untagged', name: '无标签' }, ...tags].map(tag => <Pressable key={tag.id} style={[s.button, filter.tag === tag.id && s.selected]} onPress={() => setPart({ tag: tag.id })} accessibilityState={{ selected: filter.tag === tag.id }}><Text style={s.link}>{tag.name}</Text></Pressable>)}</View>
        <Pressable style={s.button} onPress={() => setFilter(defaultPostFilter())}><Text style={s.link}>重置筛选</Text></Pressable>
      </View> : null}
      {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
      {noticeMessage ? <Text accessibilityRole="alert" style={s.muted}>{noticeMessage}</Text> : null}
      {initializationError ? <Text accessibilityRole="alert" style={ready ? s.muted : s.error}>{initializationError}</Text> : null}
      <BaiyunPostMemoryReview active={!covered && !detailId && !editor && !manager && !tagEdit} onOpenChange={setMemoryReviewOpen} onOpenPost={openDetail} />
      {!loaded ? <ActivityIndicator /> : null}
      {loaded && !error && !filtered.length ? <Text style={[s.muted, { padding: 20 }]}>{posts.length ? '没有符合筛选的动态。' : '还没有动态。'}</Text> : null}
      {feedCards}
    </ScrollView>
    {detailId ? <BaiyunPostDetail key={`${detailId}:${noticeRequest}`} noticeSource={noticeSource} covered={Boolean(covered || editor || tagEdit)} onClose={closeDetail} onInputStateChange={setDetailInput}
      card={detailPost ? { post: detailPost, comments: comments.filter(comment => comment.postId === detailId), tags,
        onEdit: openEditor, onEditTags: openTagEditor, onTag: selectTag, refresh } : null}>
      {overlays}
    </BaiyunPostDetail> : overlays}
  </KeyboardAvoidingView></PostNoticeViewportContext.Provider>;
}
