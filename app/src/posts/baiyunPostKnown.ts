import { getMemoryDatabase } from '../memory/memoryStore';
import { captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { selectBaiyunPostRecall } from './baiyunPostContract';
import { loadBaiyunPostRuntime, loadLocalBaiyunPost, loadLocalBaiyunPostComments, loadLocalBaiyunPostPage, updateBaiyunPostRuntime } from './baiyunPostStore';
import { emptyPostReplyState, initializePostReading } from './baiyunPostReplyState';
import { loadPostTags } from './baiyunPostTags';
import { postImageGroupKey, postImageOwnerKey } from './baiyunPostImageData';
import { buildPostRecallMaterial, hasReadVersion, postMaterialKey, postReadRef, type PostKnownMaterial, type PostReadingState } from './baiyunPostReading';
import type { PostCommentData, PostData } from './baiyunPostData';

type VisionRow = { owner_key: string; group_key: string; description: string | null };
export type PostRecallReference = { postId: string; sources: string[]; revision: string };

export function selectKnownPostMaterial(post: PostData, all: PostCommentData[], reading: PostReadingState | undefined,
  tags: readonly { id: string; name: string }[], vision: readonly VisionRow[]): PostKnownMaterial | null {
  const known = (item: PostData | PostCommentData) => item.author === 'I' || hasReadVersion(reading, post.id, postReadRef(item));
  if (!known(post)) return null;
  const comments = all.filter(line => line.postId === post.id && !line.deleted && known(line));
  const images: Record<string, string> = {};
  for (const item of [post, ...comments]) {
    const group = item.imageGroup;
    if (!group) continue;
    const cached = vision.find(row => row.owner_key === postImageOwnerKey({ postId: post.id, commentSource: 'source' in item ? item.source : null })
      && row.group_key === postImageGroupKey(group));
    if (!cached?.description) continue;
    const ref = postReadRef(item, { [group.id]: cached.description });
    // Repairing I's words does not erase unchanged pictures actually read in that location.
    const seen = item.author === 'I' ? reading?.rounds.some(round => round.postId === post.id
      && round.refs.some(old => old.source === ref.source && old.image === ref.image)) : hasReadVersion(reading, post.id, ref, true);
    if (seen) images[group.id] = cached.description;
  }
  return { post, comments, images, tags: post.tagIds.flatMap(id => { const tag = tags.find(item => item.id === id); return tag ? [tag.name] : []; }),
    readings: reading?.rounds.filter(round => round.postId === post.id && round.at > reading.activatedAt) ?? [] };
}

/** One activation point in the existing post journal; never move the shared questionnaire bookmark. */
export async function ensurePostReadingStarted(readOnly = false) {
  const epoch = captureBackupRestoreDataEpoch();
  let runtime = await loadBaiyunPostRuntime();
  if (!runtime.replies?.reading) {
    const page = await loadLocalBaiyunPostPage();
    if (readOnly) return initializePostReading(runtime.replies ?? emptyPostReplyState(), page.posts, page.comments, Date.now());
    await updateBaiyunPostRuntime(current => ({ ...current, replies: { ...(current.replies ?? emptyPostReplyState()),
      reading: initializePostReading(current.replies ?? emptyPostReplyState(), page.posts, page.comments, Date.now()) } }), epoch);
    runtime = await loadBaiyunPostRuntime();
  }
  return runtime.replies!.reading!;
}

/** Scoped post tables, batched comments/vision; no corpus memory scan or per-parent comment loop. */
export async function loadKnownPostMaterials(postId?: string, readOnly = false): Promise<PostKnownMaterial[]> {
  const reading = await ensurePostReadingStarted(readOnly);
  const database = await getMemoryDatabase();
  const [page, tags, vision] = await Promise.all([
    postId ? Promise.all([loadLocalBaiyunPost(postId, database), loadLocalBaiyunPostComments(postId, database)])
      .then(([post, comments]) => ({ posts: post ? [post] : [], comments })) : loadLocalBaiyunPostPage(),
    loadPostTags(), database.getAllAsync<VisionRow>(`SELECT owner_key, group_key, description FROM baiyun_post_image_vision${postId ? ' WHERE post_id = ?' : ''}`, ...(postId ? [postId] : [])),
  ]);
  return page.posts.flatMap(post => { const result = selectKnownPostMaterial(post, page.comments, reading, tags, vision); return result ? [result] : []; });
}

export function postRecallReference(material: PostKnownMaterial): PostRecallReference {
  return { postId: material.post.id, sources: material.comments.map(line => line.source), revision: postMaterialKey(buildPostRecallMaterial(material)) };
}
export async function isPostRecallCurrent(reference: PostRecallReference, readOnly = false) {
  const material = (await loadKnownPostMaterials(reference.postId, readOnly))[0];
  if (!material) return false;
  material.comments = material.comments.filter(line => reference.sources.includes(line.source));
  return postRecallReference(material).revision === reference.revision;
}

export async function loadKnownPostRecall(query: string, readOnly = false) {
  const materials = await loadKnownPostMaterials(undefined, readOnly);
  // Reuse the local relevance ranker. Only known current text participates, including tag/image terms.
  const ranked = selectBaiyunPostRecall(materials.map(({ post, tags, images }) => ({ ...post, title: post.title ?? '', legacy: false,
    content: [post.title, post.content, ...tags, post.imageGroup ? images[post.imageGroup.id] : ''].filter(Boolean).join('\n') })),
  materials.flatMap(({ comments, images }) => comments.map(line => ({ ...line, id: line.source,
    content: [line.content, line.imageGroup ? images[line.imageGroup.id] : ''].filter(Boolean).join('\n') }))), query);
  if (!ranked) return null;
  const material = materials.find(item => item.post.id === ranked.post.id)!;
  const sources = new Set(ranked.discussion.map(line => line.source));
  material.comments = material.comments.filter(line => sources.has(line.source));
  return { post: material.post, discussion: material.comments, prompt: buildPostRecallMaterial(material), reference: postRecallReference(material) };
}
