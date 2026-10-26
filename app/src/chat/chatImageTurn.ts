import { AppState, Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import type { MessageImage, SubjectiveMessage } from '../ai/subjectiveMessages';
import { loadAiConfigPreferencesSnapshot } from '../ai/AiConfigPreferences';
import { describeImageWithVisionModel } from '../ai/openAiCompatibleProvider';
import { runBudgetedAiCall } from '../ai/aiCallBudget';
import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { getFileImportRecord } from '../tools/fileToolStore';
import { getToolDefinition, listToolPackages } from '../tools/toolRegistry';
import { checkToolPermission, resolveToolPermissionForCall } from '../tools/toolPermissions';
import type { JunLuoToolCall, JunLuoToolResult } from '../tools/toolTypes';
import type { JunLuoToolCandidateSelection } from '../tools/toolCandidateSelector';
import { loadChatSessionMessage, patchStoredChatImage, claimChatImageReviewAttempt } from './chatStorage';
import { chatImageSourceRevision, chatImageQuestionRevision } from './chatImageRecord';
import { compactReplyText } from './chatMessageDisplay';
import { CHAT_IMAGE_FAILURE, CHAT_IMAGE_MISSING, CHAT_IMAGE_UNCONFIGURED, CHAT_IMAGE_TOOL_ID,
  CHAT_IMAGE_SCHEMA, chatImageMaterial, chatImageObservation } from './chatImageMaterials';

type ImageReference = { number: number; message: SubjectiveMessage; image: MessageImage; revision: string; material: string };
type ImageTurnInput = {
  messages: readonly SubjectiveMessage[]; sourceSessionId: string; sourceMessageId: string; dataEpoch: number;
  signal?: AbortSignal; isReplyCurrent?: () => Promise<boolean>;
  onSaved?: (messageId: string, image: MessageImage) => void;
};

/** Per ordinary-chat turn only. No camera, background scanning or second image store. */
export async function prepareChatImageTurn(input: ImageTurnInput) {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') return undefined;
  if (!input.messages.some(message => message.images?.length || message.replyTo)) return undefined;
  const source = await loadChatSessionMessage(input.sourceSessionId, input.sourceMessageId);
  if (!source || source.role !== 'you') return undefined;
  const sourceRevision = chatImageQuestionRevision(source);
  const refs: ImageReference[] = [];
  let claimed = !!source.chatImageReviewAttempt;
  let executing = false;
  let accessAtUse: string | undefined;
  let initiallyUnavailable = false;
  const delivered = new Set<number>();
  const alive = () => !input.signal?.aborted && canCommitBackupRestoreDataEpoch(input.dataEpoch);
  const current = async (requireForeground = true) => {
    if (!alive() || (requireForeground && AppState.currentState !== 'active') || input.isReplyCurrent && !await input.isReplyCurrent()) return false;
    const actual = await loadChatSessionMessage(input.sourceSessionId, source.id);
    return !!actual && chatImageQuestionRevision(actual) === sourceRevision && alive();
  };
  const add = async (messageId: string, selected?: SubjectiveMessage) => {
    if (refs.some(ref => ref.message.id === messageId)) return;
    const message = await loadChatSessionMessage(input.sourceSessionId, messageId);
    if (!message || message.role !== 'you' || message.deliveryStatus === 'failed') return;
    if (selected && (chatImageQuestionRevision(message) !== chatImageQuestionRevision(selected)
      || JSON.stringify(message.images?.map(i => [i.id, i.cacheId])) !== JSON.stringify(selected.images?.map(i => [i.id, i.cacheId])))) return;
    for (const original of message.images ?? []) {
      let image = original;
      if (image.visionReview) {
        const question = await loadChatSessionMessage(input.sourceSessionId, image.visionReview.sourceMessageId);
        if (!question || chatImageQuestionRevision(question) !== image.visionReview.sourceRevision) image = { ...image, visionReview: undefined };
      }
      refs.push({ number: refs.length + 1, message, image, revision: chatImageSourceRevision(message, image), material: '' });
    }
  };
  for (const message of input.messages) if (message.images?.length) await add(message.id, message);
  if (source.replyTo) {
    const quoted = await loadChatSessionMessage(input.sourceSessionId, source.replyTo.id);
    if (quoted && quoted.role === source.replyTo.role && quoted.createdAt === source.replyTo.createdAt
      && (compactReplyText(quoted.content, 140) === source.replyTo.content || quoted.content === source.replyTo.content)) await add(quoted.id);
  }
  if (!refs.length) return undefined;
  const quotedNumbers = source.replyTo ? refs.filter(ref => ref.message.id === source.replyTo!.id).map(ref => ref.number) : [];
  const refCurrent = async (ref: ImageReference, requireForeground = true) => {
    if (!await current(requireForeground) || !await accessCurrent()) return false;
    const message = await loadChatSessionMessage(input.sourceSessionId, ref.message.id);
    const image = message?.images?.find(item => item.id === ref.image.id);
    if (!message || !image || chatImageSourceRevision(message, image) !== ref.revision) return false;
    if (ref.image.visionReview) {
      const question = await loadChatSessionMessage(input.sourceSessionId, ref.image.visionReview.sourceMessageId);
      if (!question || chatImageQuestionRevision(question) !== ref.image.visionReview.sourceRevision) return false;
    }
    return alive();
  };
  const save = async (ref: ImageReference, patch: Partial<MessageImage>) => {
    if (!await refCurrent(ref)) throw new Error('CHAT_IMAGE_SOURCE_CHANGED');
    const image = await patchStoredChatImage(input.sourceSessionId, ref.message.id, ref.image.id, ref.revision, patch, {
      dataEpoch: input.dataEpoch, beforeCommit: async () => alive(),
      questionSource: { messageId: source.id, revision: sourceRevision },
    });
    if (!image) throw new Error('CHAT_IMAGE_SAVE_REJECTED');
    ref.image = image;
    input.onSaved?.(ref.message.id, image);
  };
  const result = (call: JunLuoToolCall, summary: string, ok = false, reason = 'CHAT_IMAGE_UNAVAILABLE'): JunLuoToolResult => ({
    callId: call.callId, toolId: CHAT_IMAGE_TOOL_ID, startedAt: call.createdAt, finishedAt: Date.now(),
    ok, status: ok ? 'success' : 'error', summary: ok ? '' : summary,
    ...(ok ? { data: { descriptionStatus: 'vision', observation: summary } } : { error: { code: 'EXECUTION_FAILED' as const, message: reason } }),
  });
  const permission = async (call: JunLuoToolCall) => {
    const tool = getToolDefinition(CHAT_IMAGE_TOOL_ID);
    return tool && listToolPackages().some(pack => pack.id === 'image' && pack.defaultEnabled)
      ? resolveToolPermissionForCall(tool, call) : null;
  };
  const accessCurrent = async () => {
    const state = await permission({ toolId: CHAT_IMAGE_TOOL_ID, callId: 'image-material', requestedBy: 'chat',
      sourceMessageId: source.id, createdAt: source.createdAt, input: { image: refs[0].number, question: source.content } });
    const signature = JSON.stringify(state ? [state.permission, state.source, state.grantId] : ['disabled']);
    if ((!state || state.permission === 'deny') && !initiallyUnavailable) return false;
    accessAtUse ??= signature;
    return signature === accessAtUse;
  };
  const observe = async (ref: ImageReference, question: string, kind: 'first' | 'review', call: JunLuoToolCall, signal = input.signal) => {
    if (!await refCurrent(ref) || signal?.aborted) throw new Error('CHAT_IMAGE_SOURCE_CHANGED');
    const beforePermission = await permission(call);
    if (!beforePermission || beforePermission.permission === 'deny') return result(call, CHAT_IMAGE_FAILURE);
    const config = await loadAiConfigPreferencesSnapshot({ maxAgeMs: 0 });
    if (!config.visionConnection || !config.visionKey.trim()) {
      if (kind === 'first') await save(ref, { visionStatus: 'metadata_only', visionError: CHAT_IMAGE_UNCONFIGURED });
      return result(call, CHAT_IMAGE_UNCONFIGURED);
    }
    let base64: string;
    let mime = ref.image.mimeType || 'image/jpeg';
    try {
      const record = ref.image.cacheId ? await getFileImportRecord(ref.image.cacheId) : undefined;
      if (ref.image.cacheId && (!record || record.kind !== 'image')) throw new Error('CHAT_IMAGE_FILE_MISSING');
      const uri = record?.uri ?? ref.image.uri;
      if (!uri || !/^(file|content):/i.test(uri)) throw new Error('CHAT_IMAGE_FILE_MISSING');
      mime = record?.mimeType ?? mime;
      base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      if (!base64) throw new Error('CHAT_IMAGE_FILE_EMPTY');
    } catch {
      if (kind === 'first') await save(ref, { visionStatus: 'error', visionError: CHAT_IMAGE_MISSING });
      return result(call, CHAT_IMAGE_MISSING);
    }
    let summary: string;
    try {
      const response = await runBudgetedAiCall('chatVision', 'normal', admission => describeImageWithVisionModel({
        apiKey: config.visionKey, connection: config.visionConnection!, imageDataUrl: `data:${mime};base64,${base64}`, mimeType: mime,
        chatImageMaterial: { kind, question }, signal,
        onRequestStart: async ready => {
          if (!await refCurrent(ref) || signal?.aborted) throw new Error('CHAT_IMAGE_SOURCE_CHANGED');
          const nowPermission = await permission(call);
          if (!nowPermission || nowPermission.permission === 'deny' || nowPermission.permission !== beforePermission.permission
            || nowPermission.source !== beforePermission.source) throw new Error('CHAT_IMAGE_PERMISSION_CHANGED');
          if (kind === 'first') await save(ref, { visionAttempt: { id: call.callId, startedAt: Date.now() } });
          // Keep chat writes outside the budget writer's restore lease / queue.
          await admission.beforeTransport(undefined, ready);
          if (!await refCurrent(ref) || signal?.aborted) throw new Error('CHAT_IMAGE_SOURCE_CHANGED');
          ready();
        },
      }), { connection: config.visionConnection, dataEpoch: input.dataEpoch, purpose: 'manual-chat' });
      if (!response.ok) return result(call, CHAT_IMAGE_FAILURE);
      summary = response.value;
    } catch (error) {
      if (!await refCurrent(ref) || signal?.aborted) throw error;
      const reason = typeof (error as { kind?: unknown } | null)?.kind === 'string'
        ? String((error as { kind: string }).kind) : error instanceof Error ? error.name : 'unknown';
      if (kind === 'first') await save(ref, { visionStatus: 'error', visionError: reason });
      return result(call, CHAT_IMAGE_FAILURE, false, reason);
    }
    // Local save failure must not be caught as a request failure or cause another paid request.
    if (!await refCurrent(ref) || signal?.aborted) throw new Error('CHAT_IMAGE_SOURCE_CHANGED');
    await save(ref, kind === 'first' ? { visionStatus: 'ready', visionError: undefined, visionSummary: summary, visionObservedAt: Date.now() }
      : { visionReview: { question, summary, observedAt: Date.now(), sourceMessageId: source.id, sourceRevision, executionId: call.callId } });
    return result(call, chatImageObservation(ref.number, ref.message.createdAt, summary,
      kind === 'first' ? ref.image.visionObservedAt : ref.image.visionReview?.observedAt), true);
  };
  initiallyUnavailable = !await accessCurrent();
  if (initiallyUnavailable) {
    await accessCurrent();
    for (const ref of refs) ref.image = { ...ref.image, visionStatus: 'error', visionSummary: undefined,
      visionReview: undefined, visionError: CHAT_IMAGE_FAILURE };
  }
  return {
    setCallbacks(isCurrent: ImageTurnInput['isReplyCurrent'], onSaved: ImageTurnInput['onSaved']) {
      input.isReplyCurrent = isCurrent; input.onSaved = onSaved;
    },
    async prepareFirst() {
      const ref = refs.find(ref => ref.message.id === source.id && ref.image.visionStatus === 'pending' && !ref.image.visionAttempt);
      if (!ref || initiallyUnavailable || !await current()) return;
      const call: JunLuoToolCall = { toolId: CHAT_IMAGE_TOOL_ID, callId: `image-first:${ref.image.id}`, requestedBy: 'chat',
        sourceMessageId: source.id, input: { image: ref.number, question: source.content }, createdAt: Date.now() };
      const tool = getToolDefinition(CHAT_IMAGE_TOOL_ID);
      if (!tool || !await permission(call) || (await checkToolPermission(tool, call)).decision !== 'allowed' || !await current()) return;
      await observe(ref, source.content, 'first', call);
    },
    get material() {
      // Reuse the existing reference budget; drop whole oldest observations, never their source labels.
      let remaining = 8000;
      for (const ref of [...refs].reverse()) {
        const text = chatImageMaterial(ref.number, ref.message.createdAt, ref.image);
        ref.material = text.length <= remaining ? text : '';
        remaining -= ref.material.length;
      }
      return refs.map(ref => ref.material).filter(Boolean).join('\n\n');
    },
    // Reusing saved observations may continue while a tool has opened another app.
    async checkSources() { for (const ref of refs) if (ref.material && !await refCurrent(ref, false)) return false; return current(false); },
    recoveryAccess() { return { imageNumber: refs[0].number, accessAtUse, initiallyUnavailable }; },
    cardSources(): import('./chatImageRecord').ChatImageCardSources {
      return { question: { messageId: source.id, revision: sourceRevision },
        reviewQuestions: refs.filter(ref => ref.material && ref.image.visionReview).map(ref => ({
          messageId: ref.image.visionReview!.sourceMessageId, revision: ref.image.visionReview!.sourceRevision })),
        images: refs.filter(ref => ref.material).map(ref => ({ messageId: ref.message.id, imageId: ref.image.id, revision: ref.revision })) };
    },
    async beforeTransport(materials: readonly string[]) {
      delivered.clear();
      for (const ref of refs) {
        if (!ref.material || !materials.some(text => text.includes(ref.material))) continue;
        if (!await refCurrent(ref, false)) throw new Error('CHAT_IMAGE_SOURCE_CHANGED');
        delivered.add(ref.number);
      }
    },
    async available() { return !initiallyUnavailable && !claimed && !executing && await current(); },
    addCandidate(selection: JunLuoToolCandidateSelection) {
      const original = getToolDefinition(CHAT_IMAGE_TOOL_ID);
      if (!original || initiallyUnavailable || claimed || !listToolPackages().some(pack => pack.id === 'image' && pack.defaultEnabled)) return selection;
      const tool = { ...original, name: '再看图片', description: '结合这次想确认的问题，再看一张 you 已经发来的图片。',
        inputSchema: CHAT_IMAGE_SCHEMA, chatExposure: 'internal_only' as const };
      const candidate = { tool, source: 'available_confirmation' as const, strength: 'possible' as const, executionMode: 'executable' as const,
        authority: { kind: 'available_confirmation' as const, dataEpoch: input.dataEpoch, allowedToolIds: [tool.id] } };
      return { ...selection, mode: selection.mode === 'chat_only' ? 'direct_tools' as const : selection.mode,
        candidates: [...selection.candidates.filter(c => c.tool.id !== tool.id), candidate],
        executableTools: [...selection.executableTools.filter(t => t.id !== tool.id), tool], tools: [...selection.tools.filter(t => t.id !== tool.id), tool],
        packages: [...new Set([...selection.packages, 'image'])],
        reasons: [...selection.reasons, { toolId: tool.id, source: candidate.source, strength: candidate.strength }],
        serializedCharacterCount: selection.serializedCharacterCount + JSON.stringify(tool.inputSchema).length + tool.description.length };
    },
    async execute(call: JunLuoToolCall, signal: AbortSignal) {
      const number = call.input.image, question = call.input.question;
      const ref = refs.find(ref => ref.number === number);
      if (initiallyUnavailable || call.requestedBy !== 'chat' || call.sourceMessageId !== source.id || !ref || !delivered.has(ref.number)
        || quotedNumbers.length && !quotedNumbers.includes(ref.number) || typeof question !== 'string' || !question.trim()
        || Object.keys(call.input).some(key => key !== 'image' && key !== 'question') || claimed || executing || signal.aborted) return result(call, CHAT_IMAGE_FAILURE);
      executing = true;
      try {
        if (!await refCurrent(ref)) return result(call, CHAT_IMAGE_FAILURE);
        claimed = true;
        if (!await claimChatImageReviewAttempt(input.sourceSessionId, source.id, sourceRevision, call.callId, input.dataEpoch)) return result(call, CHAT_IMAGE_FAILURE);
        return await observe(ref, question, 'review', call, signal);
      } finally { executing = false; }
    },
  };
}
