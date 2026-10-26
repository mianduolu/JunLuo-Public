import { isLetterMemorySource, isVoiceCallMemorySource, isObservationMemorySource, loadMemorySourceMessage, loadMemorySourceEvidence } from './memorySourceReader';
import { loadLetterMemoryPart } from '../letters/letterMemorySource';
import { currentStateVersion, loadMemoryCurrentState, type MemoryCurrentState } from './memoryCurrentStateStore';
import type { CurrentStateReadReference, ShiyingReadReference, PostReadReference } from './memoryReadReference';
import { loadPostRecallSnapshot } from '../posts/baiyunPostRecallSource';
import { loadShiyingMemorySnapshot, makeShiyingMemoryMessage, getShiyingMemoryMessageInfo } from '../shiying/shiyingMemorySource';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { isBaiyunPostMemory } from '../posts/baiyunPostContract';
import { getTheaterBackstageContext } from '../ai/subjectiveMessages';
import { getVoiceCallMemorySourceContext, getVoiceCallMemorySourceInfo } from '../voiceCall/voiceCallMemorySource';
import { getReadingMemorySourceContext, readingMemorySourceContextVersion } from '../reading/readingMemoryContext';
import { stableMemoryHash } from './memoryAtomicity';
import { currentMemoryComments } from './memoryCurrentMaterials';
import { loadMemorySourceSelectionCandidates } from './memorySourceTrace';
import { commentFromRow, getMemoryDatabase, loadMemorySourceRefs, memoryFromRow, type MemoryRecallItem, type MemoryEntry, type MemoryComment, type MemorySourceRef } from './memoryStore';
import { getWeeklyContextStatus, weeklyTargetHash, type WeeklyDatabase } from './memoryWeeklyBasis';
import { getUnderstandingStatus, understandingMessageHash } from './memoryUnderstanding';
import { getMemorySourceStatus, memorySourceStatusLabel, getMemorySourceStatusLabel, type MemorySourceStatus } from './memorySourceStatus';
import type { PostMemoryReadOptions } from '../posts/baiyunPostMemorySource';
import type { CameraObservationRecordV1 } from '../camera/cameraObservationTypes';
import { isCompleteObservationExcerpt } from './memorySourceRefs';
import type { ObservationMaterialBinding } from './memoryObservationIngestion';

export type MemoryReadView = 'memory' | 'source';
export type MemoryReadPart = {
  kind: 'body' | 'comment' | 'source';
  content: string;
  context?: string;
  commentId?: string;
  commentKind?: string;
  sessionId?: string;
  messageId?: string;
  role?: 'I' | 'you';
  createdAt?: number;
  relation?: 'direct' | 'derived';
  available?: boolean;
  retainedExcerpt?: boolean;
  sourceStatus?: MemorySourceStatus;
  sourceLabel?: string;
  /** Full original material version; internal validation only. */
  sourceHash?: string;
  /** Local pagination material. Neither field is sent as a model-visible parameter. */
  observationRecord?: CameraObservationRecordV1;
  observationBinding?: ObservationMaterialBinding;
};
export type MemoryReadSnapshot = {
  reference: MemoryRecallItem;
  parts: MemoryReadPart[];
  version: string;
  /** Source identity without the enclosing memory body; not sent to the model. */
  sourceContentVersion?: string;
  view: MemoryReadView;
};
export type CurrentStateReadSnapshot = Omit<MemoryReadSnapshot, 'reference'> & { reference: CurrentStateReadReference };
export type ShiyingReadSnapshot = Omit<MemoryReadSnapshot, 'reference'> & { reference: ShiyingReadReference };
export type PostReadSnapshot = Omit<MemoryReadSnapshot, 'reference'> & { reference: PostReadReference };
export type AnyMemoryReadSnapshot = MemoryReadSnapshot | CurrentStateReadSnapshot | ShiyingReadSnapshot | PostReadSnapshot;

export async function loadPostReadSnapshot(id: string, view: MemoryReadView, options: PostMemoryReadOptions = {}): Promise<PostReadSnapshot | 'missing'> {
  const post = await loadPostRecallSnapshot(id, options);
  if (!post) return 'missing';
  const parts: MemoryReadPart[] = post.sources.map(source => ({
    kind: view === 'source' ? 'source' : source.kind === 'post' ? 'body' : 'comment',
    content: source.content, sessionId: source.sessionId, messageId: source.messageId,
    role: source.role, createdAt: source.createdAt, available: true,
    sourceStatus: 'exact', sourceLabel: memorySourceStatusLabel.exact, sourceHash: source.sourceVersion,
  }));
  return { reference: { targetKind: 'post', post, version: post.materialHash }, parts, view, version: post.materialHash };
}

export async function loadShiyingReadSnapshot(id: string, view: MemoryReadView): Promise<ShiyingReadSnapshot | 'missing'> {
  const paper = await loadShiyingMemorySnapshot(id);
  if (!paper) return 'missing';
  const parts: MemoryReadPart[] = [];
  for (const part of ['body', 'image_note'] as const) {
    const message = makeShiyingMemoryMessage(paper, part);
    if (!message) continue;
    const info = getShiyingMemoryMessageInfo(message)!;
    parts.push({ kind: view === 'source' ? 'source' : part === 'body' ? 'body' : 'comment',
      ...(part === 'image_note' ? { commentKind: '图片记录' } : {}), content: message.content,
      role: message.role as 'I' | 'you', createdAt: message.createdAt, sessionId: info.sessionId, messageId: message.id,
      relation: 'direct', available: true, retainedExcerpt: false,
      sourceStatus: 'exact', sourceLabel: memorySourceStatusLabel.exact, sourceHash: info.sourceHash });
  }
  const latest = await loadShiyingMemorySnapshot(id);
  if (!latest || latest.materialHash !== paper.materialHash) return 'missing';
  return { reference: { targetKind: 'shiying_record', shiying: paper, version: paper.materialHash },
    parts, view, version: stableMemoryHash(JSON.stringify([paper.materialHash, view, parts])) };
}

export type CurrentStateSourceReader = (sessionId: string, messageId: string) => Promise<SubjectiveMessage | null>;

export async function loadObservationReadPart(ref: Pick<MemorySourceRef, 'sessionId' | 'messageId' | 'messageCreatedAt' | 'relation' | 'excerpt'>): Promise<MemoryReadPart> {
  const source = await loadMemorySourceEvidence(ref.sessionId, ref.messageId);
  const record = source?.kind === 'observation' ? source.record : undefined;
  const excerpt = isCompleteObservationExcerpt(ref.excerpt)
    && ref.excerpt.includes(`[observationId=${ref.messageId}]`) ? ref.excerpt : undefined;
  const retainedExcerpt = !record && !!excerpt;
  const sourceStatus = getMemorySourceStatus({ available: !!record, retainedExcerpt, mode: 'exact' });
  const observation = record ? await import('./memoryObservationIngestion') : undefined;
  return { kind: 'source', content: record ? observation!.renderObservationMaterial(record) : excerpt ?? '',
    sessionId: ref.sessionId, messageId: ref.messageId, role: 'I', createdAt: record?.capturedAt ?? ref.messageCreatedAt,
    relation: ref.relation, available: !!record, retainedExcerpt,
    sourceStatus, sourceLabel: getMemorySourceStatusLabel(sourceStatus, true),
    ...(record ? { sourceHash: observation!.getObservationSourceHash(record), observationRecord: record } : {}) };
}

async function letterSourceVersions(parts: MemoryReadPart[]) {
  return Promise.all(parts.filter(part => part.kind === 'source' && part.sessionId && isLetterMemorySource(part.sessionId))
    .map(async part => [part.sessionId, part.messageId,
      (await loadLetterMemoryPart(part.sessionId!, part.messageId!))?.sourceHash ?? null]));
}
export async function loadCurrentStateSourceParts(state: MemoryCurrentState,
  readMessage: CurrentStateSourceReader = loadMemorySourceMessage): Promise<MemoryReadPart[]> {
  return Promise.all(state.sourceRefs.map(async ref => {
    if (isObservationMemorySource(ref.sessionId)) return loadObservationReadPart(ref);
    const message = await readMessage(ref.sessionId, ref.messageId);
    const contentHash = (ref as typeof ref & { contentHash?: string }).contentHash;
    const available = !!message && message.role === ref.role && message.createdAt === ref.messageCreatedAt
      && (!contentHash || stableMemoryHash(message.content) === contentHash);
    const retainedExcerpt = !available && !!ref.excerpt;
    const sourceStatus = getMemorySourceStatus({ available, retainedExcerpt, mode: 'exact' });
    const context = available ? getReadingMemorySourceContext(message!) || getVoiceCallMemorySourceContext(message!) || getTheaterBackstageContext(message!) : '';
    return { kind: 'source' as const, content: available ? message!.content : ref.excerpt ?? '',
      ...(context ? { context } : {}), sessionId: ref.sessionId, messageId: ref.messageId, role: ref.role,
      ...(available && ref.sessionId.startsWith('post-source:') ? { sourceHash: understandingMessageHash(ref.sessionId, message!) } : {}),
      createdAt: ref.messageCreatedAt, relation: ref.relation, available, retainedExcerpt,
      sourceStatus, sourceLabel: memorySourceStatusLabel[sourceStatus] };
  }));
}
export async function loadCurrentStateReadSnapshot(id: string, view: MemoryReadView, database?: WeeklyDatabase,
  readMessage: CurrentStateSourceReader = loadMemorySourceMessage,
  options: { postComparison?: boolean; shiyingComparison?: boolean; postOptions?: PostMemoryReadOptions } = {}): Promise<CurrentStateReadSnapshot | 'missing' | 'unavailable'> {
  const db = database ?? await getMemoryDatabase();
  const state = await loadMemoryCurrentState(id, db);
  if (!state || state.status !== 'active') return 'missing';
  if (!options.shiyingComparison && !(await (await import('../shiying/shiyingMemorySource'))
    .isShiyingOrganizationMemoryCurrent(db, id, state.sourceRefs))) return 'unavailable';
  const { getPostDerivedStatus } = await import('../posts/baiyunPostMemoryBasis');
  if (!options.postComparison && (await getPostDerivedStatus(db, 'current_state', id, state.sourceRefs, options.postOptions)).status !== 'current') return 'unavailable';
  const readSource = database && readMessage === loadMemorySourceMessage && state.sourceRefs.some(ref => isVoiceCallMemorySource(ref.sessionId) || ref.sessionId.startsWith('post-source:'))
    ? (sessionId: string, messageId: string) => loadMemorySourceMessage(sessionId, messageId, { ...options.postOptions, database: db, waitForPendingWrites: false }) : readMessage;
  const parts: MemoryReadPart[] = view === 'memory' ? [{ kind: 'body', content: state.content }]
    : await loadCurrentStateSourceParts(state, readSource);
  const sourceVersions = await letterSourceVersions(parts);
  const version = currentStateVersion(state);
  const current = await loadMemoryCurrentState(id, db);
  if (!current || current.status !== 'active' || currentStateVersion(current) !== version) return 'missing';
  if (!options.shiyingComparison && !(await (await import('../shiying/shiyingMemorySource'))
    .isShiyingOrganizationMemoryCurrent(db, id, current.sourceRefs))) return 'unavailable';
  if (!options.postComparison && (await getPostDerivedStatus(db, 'current_state', id, current.sourceRefs, options.postOptions)).status !== 'current') return 'unavailable';
  return { reference: { targetKind: 'current_state', currentState: state, version }, parts, view,
    version: stableMemoryHash(JSON.stringify([version, parts, ...(sourceVersions.length ? [sourceVersions] : [])])) };
}

export async function loadMemoryReadSnapshot(
  id: string, view: MemoryReadView, database?: WeeklyDatabase,
  // Only supplied immediately after the material preparation's current/derived checks.
  checked?: { memory: MemoryEntry; comments: MemoryComment[]; refs: MemorySourceRef[]; readSource: CurrentStateSourceReader },
  postOptions: PostMemoryReadOptions = {},
): Promise<MemoryReadSnapshot | 'missing' | 'weekly_stale' | 'understanding_stale' | 'unavailable'> {
  const db = database ?? await getMemoryDatabase();
  if (checked && checked.memory.id !== id) throw new Error('MEMORY_SOURCE_ID_MISMATCH');
  const row = checked ? undefined : await db.getFirstAsync<Parameters<typeof memoryFromRow>[0]>('SELECT * FROM memories WHERE id = ?', id);
  if (!checked && !row) return 'missing';
  const memory = checked?.memory ?? memoryFromRow(row!);
  // Posts have their own author/reading/image-version gate; generic memory.read must not bypass it.
  if (isBaiyunPostMemory(memory)) return 'missing';
  if (!(await (await import('../reading/readingMemoryOrganizationSource')).isReadingOrganizationMemoryCurrent(db, id, checked?.refs))) return 'unavailable';
  if (!(await (await import('../shiying/shiyingMemorySource')).isShiyingOrganizationMemoryCurrent(db, id, checked?.refs))) return 'unavailable';
  const { getPostDerivedStatus } = await import('../posts/baiyunPostMemoryBasis');
  if ((await getPostDerivedStatus(db, 'memory', id, checked?.refs, postOptions)).status !== 'current') return 'unavailable';
  if (!checked && await getUnderstandingStatus(db, memory, postOptions) !== 'current') return 'understanding_stale';
  if (!checked && await getWeeklyContextStatus(db, memory, postOptions) !== 'current') return 'weekly_stale';
  const comments = checked?.comments ?? currentMemoryComments(memory, (await db.getAllAsync<Parameters<typeof commentFromRow>[0]>(
    'SELECT * FROM memory_comments WHERE memory_id = ?', id,
  )).map(commentFromRow));
  const parts: MemoryReadPart[] = [];
  const storySources: string[] = [];
  if (view === 'memory') {
    parts.push({ kind: 'body', content: memory.content });
    for (const comment of comments.filter(item => item.kind !== 'dehydration')) {
      parts.push({ kind: 'comment', commentId: comment.id, commentKind: comment.kind,
        createdAt: comment.createdAt, content: comment.content });
    }
  } else if (memory.sourceTraceMode === 'exact') {
    const refs = checked?.refs ?? await loadMemorySourceRefs(id, db);
    const readSource = checked?.readSource ?? (database && refs.some(ref => isVoiceCallMemorySource(ref.sessionId) || ref.sessionId.startsWith('post-source:'))
      ? (sessionId: string, messageId: string) => loadMemorySourceMessage(sessionId, messageId, { ...postOptions, database, waitForPendingWrites: false }) : loadMemorySourceMessage);
    for (const ref of refs) {
      if (isObservationMemorySource(ref.sessionId)) {
        parts.push(await loadObservationReadPart(ref));
        continue;
      }
      const found = await readSource(ref.sessionId, ref.messageId);
      const message = found?.id === ref.messageId && found.role === ref.role ? found : undefined;
      const retainedExcerpt = !message && !!ref.excerpt;
      const context = message ? getReadingMemorySourceContext(message) || getVoiceCallMemorySourceContext(message) || getTheaterBackstageContext(message) : '';
      const sourceStatus = getMemorySourceStatus({ available: !!message, retainedExcerpt, mode: 'exact' });
      if (context || message && getVoiceCallMemorySourceInfo(message)) storySources.push(understandingMessageHash(ref.sessionId, message!));
      if (message && ref.sessionId.startsWith('post-source:')) storySources.push(understandingMessageHash(ref.sessionId, message));
      if (message && readingMemorySourceContextVersion(message)) storySources.push(readingMemorySourceContextVersion(message)!);
      parts.push({ kind: 'source', content: message?.content ?? ref.excerpt ?? '',
        ...(context ? { context } : {}),
        sessionId: ref.sessionId, messageId: ref.messageId, role: ref.role,
        createdAt: message?.createdAt ?? ref.messageCreatedAt, relation: ref.relation,
        available: !!message, retainedExcerpt,
        sourceStatus, sourceLabel: memorySourceStatusLabel[sourceStatus] });
    }
  } else if (memory.sourceTraceMode === 'legacy_range'
    && Number.isFinite(memory.sourceStartAt) && Number.isFinite(memory.sourceEndAt)
    && memory.sourceEndAt! >= memory.sourceStartAt!) {
    const groups = await loadMemorySourceSelectionCandidates(memory);
    for (const group of groups) for (const message of group.messages) {
      if (message.role !== 'I' && message.role !== 'you') continue;
      const context = getTheaterBackstageContext(message);
      if (context) storySources.push(understandingMessageHash(group.sessionId, message));
      parts.push({ kind: 'source', content: message.content, sessionId: group.sessionId,
        ...(context ? { context } : {}),
        messageId: message.id, role: message.role, createdAt: message.createdAt,
        available: true, retainedExcerpt: false, sourceStatus: 'legacy_range', sourceLabel: memorySourceStatusLabel.legacy_range });
    }
    parts.sort((left, right) => left.createdAt! - right.createdAt! || left.messageId!.localeCompare(right.messageId!));
  }
  const sourceVersions = await letterSourceVersions(parts);
  if ((await getPostDerivedStatus(db, 'memory', id, checked?.refs, postOptions)).status !== 'current') return 'unavailable';
  return {
    reference: { memory, reason: 'direct', commentsChecked: true,
      latestComment: comments.find(comment => comment.kind === 'dehydration') ?? comments[0] },
    parts, view,
    sourceContentVersion: view === 'source' ? stableMemoryHash(JSON.stringify([parts,
      ...(storySources.length ? [storySources] : []), ...(sourceVersions.length ? [sourceVersions] : [])])) : undefined,
    version: stableMemoryHash(JSON.stringify([weeklyTargetHash(memory), parts,
      ...(storySources.length ? [storySources] : []), ...(sourceVersions.length ? [sourceVersions] : [])])),
  };
}
