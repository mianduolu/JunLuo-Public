import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Image, Modal, Pressable, View } from 'react-native';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { baiyunStatusPortraits, homeImages } from '../assets/homeImages';
import { visiblePostComments, type PostAuthor, type PostCommentData, type PostData } from './baiyunPostData';
import { revisePostImageGroup } from './baiyunPostImageData';
import { retainPostDraftImages } from './baiyunPostImageFiles';
import { deleteBaiyunPost, deleteLocalBaiyunPostComment, saveBaiyunPostComment } from './baiyunPostStore';
import type { PostTag } from './baiyunPostTags';
import { displayedPostComments, postAuthorName, postTime, type PostCommentOrder } from './baiyunPostPresentation';
import { PostImageEditor, PostImages } from './BaiyunPostImages';
import { BaiyunPostReplyStatus } from './BaiyunPostReplyStatus';
import { postNoticeKey } from './baiyunPostNotice';
import { PostNoticeView, usePostNoticeCover } from './BaiyunPostNoticeViewport';
import type { PostEditTarget } from './BaiyunPostEditor';
import { postColors as c, postStyles as s } from './baiyunPostStyles';

export function PostAvatar({ author, mini = false }: { author: PostAuthor; mini?: boolean }) {
  return <View style={[s.avatar, mini && s.miniAvatar, author === 'you' && { backgroundColor: '#FFF0E2' }]}>
    <Image accessibilityLabel={postAuthorName(author)} source={author === 'you' ? homeImages.mePortraitDefault : baiyunStatusPortraits.calm}
      resizeMode="cover" style={s.portrait} />
  </View>;
}

export type PostCommentInputState = { hasDraft: boolean; busy: boolean };
function BaiyunPostCardView({ post, comments, tags, onEdit, onEditTags, onTag, refresh, detail = false, onOpen, onCommentStateChange, initialCommentSource }: {
  post: PostData; comments: PostCommentData[]; tags: PostTag[];
  onEdit: (target: PostEditTarget) => void; onEditTags: (post: PostData) => void;
  onTag: (id: string) => void; refresh: (changed?: boolean) => Promise<void>;
  detail?: boolean; onOpen?: (id: string) => void; onCommentStateChange?: (state: PostCommentInputState) => void;
  initialCommentSource?: string;
}) {
  const [expanded, setExpanded] = useState(() => Boolean(initialCommentSource
    && !displayedPostComments(comments, false).some(comment => comment.source === initialCommentSource)));
  const [order, setOrder] = useState<PostCommentOrder>('newest');
  const [composing, setComposing] = useState(false);
  const [menu, setMenu] = useState<'post' | PostCommentData | null>(null);
  usePostNoticeCover(menu !== null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const createdTime = useMemo(() => postTime(post.createdAt), [post.createdAt]);
  const visible = detail ? visiblePostComments(comments) : [];
  const shown = detail ? displayedPostComments(comments, expanded, order) : [];
  const mutate = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    let failed = false;
    try { await action(); } catch { failed = true; setError('保存失败，请刷新后重试。'); }
    finally { lock.current = false; setBusy(false); await refresh(failed); }
  };
  const remove = (comment?: PostCommentData) => {
    setMenu(null);
    Alert.alert(comment ? '删除这条评论？' : '删除这条动态？', comment ? '只删除这一条和它的图片，后面的评论保留。' : '这条动态、图片和下面的全部评论会一起删除。', [
      { text: '取消', style: 'cancel' }, { text: '删除', style: 'destructive', onPress: () => void mutate(() => comment
        ? deleteLocalBaiyunPostComment(post.id, comment.source) : deleteBaiyunPost(post.id)) },
    ]);
  };
  const menuAuthor = menu === 'post' ? post.author : menu?.author;
  return <View style={[s.card, post.author === 'you' ? s.youCard : s.cloudCard]}>
    <View style={s.row}><PostAvatar author={post.author} /><View style={s.grow}>
      <Text style={[s.text, { color: post.author === 'you' ? c.orange : c.blue }]}>{postAuthorName(post.author)}</Text>
      <Text style={s.muted}>{createdTime}{post.updatedAt > post.createdAt ? ' · 已编辑' : ''}</Text>
    </View><Pressable disabled={busy} accessibilityLabel="动态菜单" style={s.button} onPress={() => setMenu('post')}><Text style={s.link}>⋯</Text></Pressable></View>
    <PostNoticeView noticeKey={post.author === 'I' ? postNoticeKey(post.id) : undefined} style={{ gap: 12 }}>
    <Pressable disabled={detail} accessibilityRole={detail ? undefined : 'button'} accessibilityLabel={detail ? undefined : '查看动态详情'}
      onPress={() => onOpen?.(post.id)} style={{ gap: 12 }}>
      {post.title ? <Text selectable={detail} style={s.heading}>{post.title}</Text> : null}
      {post.content ? <Text selectable={detail} style={s.text}>{post.content}</Text> : null}
    </Pressable>
    <PostImages ids={post.imageGroup?.imageIds ?? []} />
    </PostNoticeView>
    <View style={s.wrap}>{post.tagIds.map(id => tags.find(tag => tag.id === id)).filter(tag => tag !== undefined).map(tag =>
      <Pressable key={tag.id} style={s.button} onPress={() => onTag(tag.id)}><Text style={s.link}>#{tag.name}</Text></Pressable>)}
      <View style={s.grow} /><Pressable accessibilityRole="button" style={s.button} onPress={detail ? () => setComposing(true) : () => onOpen?.(post.id)}><Text style={s.link}>评论 {comments.filter(comment => !comment.deleted).length}</Text></Pressable>
    </View>
    {detail && composing ? <CommentComposer postId={post.id} refresh={refresh} onClose={() => setComposing(false)} onStateChange={onCommentStateChange} /> : null}
    {detail ? <View style={s.comments}>
      <BaiyunPostReplyStatus postId={post.id} />
      <View style={s.wrap}><Text style={[s.heading, s.grow]}>评论</Text>
        {(['newest', 'oldest'] as const).map(value => <Pressable key={value} accessibilityState={{ selected: order === value }}
          style={[s.button, order === value && s.selected]} onPress={() => setOrder(value)}>
          <Text style={s.link}>{value === 'newest' ? '最新在前' : '最早在前'}</Text>
        </Pressable>)}
      </View>
      {!visible.length ? <Text style={s.muted}>还没有评论。</Text> : null}
      {shown.map(comment => <PostNoticeView key={comment.source} style={s.comment}
        noticeKey={!comment.deleted && comment.author === 'I' ? postNoticeKey(post.id, comment.source) : undefined}>
        {comment.deleted ? <Text style={s.muted}>该评论已删除</Text> : <>
          <PostAvatar author={comment.author} mini /><View style={[s.grow, { gap: 4 }]}>
            {comment.content ? <Text selectable style={s.commentBody}>{comment.content}</Text> : null}
            <PostImages ids={comment.imageGroup?.imageIds ?? []} />
            <Text style={s.muted}>{postTime(comment.createdAt)}{comment.updatedAt > comment.createdAt ? ' · 已编辑' : ''}</Text>
          </View><Pressable disabled={busy} accessibilityLabel={`${postAuthorName(comment.author)}的评论菜单`} style={s.button} onPress={() => setMenu(comment)}><Text style={s.link}>⋯</Text></Pressable>
        </>}
      </PostNoticeView>)}
      {visible.length > 6 ? <Pressable accessibilityState={{ expanded }} style={[s.button, { alignSelf: 'flex-start' }]} onPress={() => setExpanded(value => !value)}><Text style={s.link}>{expanded ? '收起' : `展开全部 ${comments.filter(comment => !comment.deleted).length} 条评论`}</Text></Pressable> : null}
    </View> : null}
    {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
    {menu ? <Modal transparent animationType="fade" onRequestClose={() => setMenu(null)}><View style={s.overlay}><View style={s.dialog}>
      {menuAuthor === 'you' ? <Pressable style={s.button} onPress={() => { onEdit({ post, comment: menu === 'post' ? undefined : menu }); setMenu(null); }}><Text style={s.link}>编辑</Text></Pressable> : null}
      {menu === 'post' ? <Pressable style={s.button} onPress={() => { setMenu(null); onEditTags(post); }}><Text style={s.link}>编辑标签</Text></Pressable> : null}
      {menu === 'post' || menuAuthor === 'you' ? <Pressable style={s.button} onPress={() => remove(menu === 'post' ? undefined : menu)}><Text style={s.error}>{menu === 'post' ? '删除整条动态' : '删除评论'}</Text></Pressable> : null}
      {menuAuthor === 'I' ? <Pressable style={s.button} onPress={() => { onEdit({ post, comment: menu === 'post' ? undefined : menu }); setMenu(null); }}><Text style={s.muted}>修修</Text></Pressable> : null}
      <Pressable style={s.button} onPress={() => setMenu(null)}><Text style={s.link}>取消</Text></Pressable>
    </View></View></Modal> : null}
  </View>;
}

// Database reads return fresh objects even when these small, JSON-only records are unchanged.
// Compare every prop, including callbacks, so a retained card never keeps an obsolete action.
export const BaiyunPostCard = memo(BaiyunPostCardView, (before, after) =>
  Object.keys(before).length === Object.keys(after).length &&
  (Object.keys(after) as (keyof typeof after)[]).every(key => Object.is(before[key], after[key]) ||
    (['post', 'comments', 'tags'].includes(key) && JSON.stringify(before[key]) === JSON.stringify(after[key]))));

function CommentComposer({ postId, refresh, onClose, onStateChange }: {
  postId: string; refresh: () => Promise<void>; onClose: () => void; onStateChange?: (state: PostCommentInputState) => void;
}) {
  const [content, setContent] = useState('');
  const [imageIds, setImages] = useState<string[]>([]);
  const [imageBusy, setImageBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const newSource = () => `post-comment-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const [source, setSource] = useState(newSource);
  const currentSource = useRef(source);
  useEffect(() => {
    onStateChange?.({ hasDraft: Boolean(content.trim() || imageIds.length), busy: sending || imageBusy });
  }, [content, imageIds.length, sending, imageBusy, onStateChange]);
  useEffect(() => () => onStateChange?.({ hasDraft: false, busy: false }), [onStateChange]);
  const send = async () => {
    if (lock.current || source !== currentSource.current || imageBusy || (!content.trim() && !imageIds.length)) return;
    lock.current = true; setSending(true); setError('');
    let committed = false;
    try {
      await saveBaiyunPostComment({ postId, source, author: 'you', content, imageGroup: revisePostImageGroup(null, imageIds) }, () => {
        committed = true;
        currentSource.current = newSource();
        setContent(''); setImages([]); setSource(currentSource.current);
        lock.current = false; setSending(false);
        // The formal comment already owns its pictures; release only this completed draft's key.
        void retainPostDraftImages(source, []).catch(() => undefined);
      });
      // Saved locally only. Natural ten-dimensional opportunities are wired in chapter 5.
      await refresh();
    } catch { if (!committed) setError('评论保存失败，内容已保留，请重试。'); }
    finally { if (!committed) { lock.current = false; setSending(false); } }
  };
  return <View style={{ gap: 8 }}>
    <TextInput accessibilityLabel="评论正文" multiline textAlignVertical="top" value={content} editable={!sending && !imageBusy} onChangeText={setContent} placeholder="评论…" style={s.input} />
    <PostImageEditor key={source} ids={imageIds} draftKey={source} disabled={sending} onBusy={setImageBusy} onChange={async ids => { setImages(ids); }} />
    {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
    <View style={[s.row, { justifyContent: 'flex-end' }]}>
      <Pressable disabled={sending || imageBusy} style={s.button} onPress={() => {
        if (!content.trim() && !imageIds.length) onClose();
        else Alert.alert('放弃这条未发送的评论？', '正文和已选图片会清空。', [{ text: '继续编辑', style: 'cancel' }, { text: '放弃', style: 'destructive', onPress: onClose }]);
      }}><Text style={s.link}>收起输入</Text></Pressable>
      <Pressable disabled={sending || imageBusy || (!content.trim() && !imageIds.length)} onPress={() => void send()} style={[s.button, s.primary, (sending || imageBusy || (!content.trim() && !imageIds.length)) && s.disabled]}><Text style={s.primaryText}>{sending ? '保存中' : '发送评论'}</Text></Pressable>
    </View>
  </View>;
}
