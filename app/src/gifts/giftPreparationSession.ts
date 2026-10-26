import * as FileSystem from 'expo-file-system/legacy';
import { randomUUID } from 'expo-crypto';
import { canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { writeStringFileSafely } from '../storage/safeFileWrite';
import { getFileImportRecord, listRecentFileImports, type JunLuoFileImportRecord } from '../tools/fileToolStore';
import { createGiftDraft, saveGiftDraft, loadGiftView, listGiftViews, recordGiftDelivery, scheduleGiftDelivery, cancelGiftSchedule, appendGiftAttachments } from './giftStore';
import { giftOriginalUri, giftOriginals } from './giftFiles';
import { emitGiftChanges } from './giftEvents';
import type { GiftDraftAttachmentInput, GiftFileKind, GiftFileSource, GiftRecord, GiftView, GiftWorkToken, GiftSupplementAttachmentInput } from './giftTypes';

export type GiftPreparationAttachment = { kind: 'keep'; attachmentId: string } | { kind: 'file'; fileId: string }
  | { kind: 'url'; url: string } | { kind: 'html'; name: string; html: string };
export type GiftPreparationInput = { giftId?: string; title: string; note: string;
  attachments: readonly GiftPreparationAttachment[]; coverFileId?: string | null };
export type GiftPreparationFile = { fileId: string; name: string; kind: GiftFileKind; mimeType: string; byteSize: number };
export type GiftPreparationView = { gifts: GiftView[]; files: GiftPreparationFile[];
  htmlSources: Array<{ attachmentId: string; originalId: string; content: string; through: number; total: number; complete: boolean }> };
type Source = GiftPreparationFile & { file: GiftFileSource; record?: JunLuoFileImportRecord;
  gift?: GiftWorkToken & { attachmentId: string; originalId: string } };
export type GiftPreparationCheckpoint = { dataEpoch: number | null; gifts: GiftWorkToken[]; sources: Source[] };

/** Saved facts remain available even when a later context check or temporary cleanup fails. */
export class GiftPreparationError extends Error {
  constructor(code: string, readonly giftId?: string, readonly savedGift?: GiftRecord, readonly cleanupFailed = 0) { super(code); }
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const id = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value === value.trim();
function failure(error: unknown, giftId?: string, savedGift?: GiftRecord, cleanupFailed = 0) {
  if (error instanceof GiftPreparationError) return error;
  const code = error instanceof Error && /^gift-[a-z-]+$/.test(error.message) ? error.message : 'gift-preparation-file-failed';
  return new GiftPreparationError(code, giftId, savedGift, cleanupFailed);
}
const imageMime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/** A caller owns one current opportunity. Neither subject, local paths nor revisions come from its arguments. */
export function createGiftPreparationSession(input: { dataEpoch: number | null; isCurrent?: () => boolean | Promise<boolean>;
  checkpoint?: GiftPreparationCheckpoint }) {
  const epoch = input.dataEpoch, current = input.isCurrent;
  const bindings = new Map<string, GiftWorkToken>(), sources = new Map<string, Source>();
  if (input.checkpoint) {
    if (input.checkpoint.dataEpoch !== epoch) throw Error('gift-stale-data-epoch');
    for (const token of input.checkpoint.gifts) {
      if (token.dataEpoch !== epoch || !id(token.id) || !Number.isSafeInteger(token.revision) || token.revision < 1) throw Error('gift-invalid-checkpoint');
      bindings.set(token.id, copy(token));
    }
    for (const source of input.checkpoint.sources) {
      if (!id(source.fileId) || !source.record && !source.gift || source.gift && source.gift.dataEpoch !== epoch) throw Error('gift-invalid-checkpoint');
      sources.set(source.fileId, copy(source));
    }
  }
  let queue: Promise<unknown> = Promise.resolve();
  const ready = async () => {
    if (!canCommitBackupRestoreDataEpoch(epoch)) throw Error('gift-stale-data-epoch');
    if (current && !await current()) throw Error('gift-preparation-source-changed');
    if (!canCommitBackupRestoreDataEpoch(epoch)) throw Error('gift-stale-data-epoch');
  };
  const run = <T>(work: () => Promise<T>): Promise<T> => {
    const pending = queue.catch(() => undefined).then(async () => {
      await ready();
      const result = await runBackupRestoreDataEpochCommit(epoch, async () => { await ready(); return work(); });
      if (!result.committed) throw Error('gift-stale-data-epoch');
      return result.value;
    });
    queue = pending; return pending;
  };
  const fileInfo = async (file: GiftFileSource, expected?: number) => {
    const info = await FileSystem.getInfoAsync(file.uri); await ready();
    if (!info.exists || info.isDirectory || !Number.isSafeInteger(info.size) || info.size < 1) throw Error('gift-original-missing');
    if (expected !== undefined && info.size !== expected) throw Error('gift-preparation-source-changed');
    return info.size;
  };
  const bindGiftSources = (gift: GiftRecord, target = sources) => {
    for (const attachment of gift.attachments) if (attachment.kind !== 'url') {
      const original = attachment.original;
      target.set(attachment.id, { fileId: attachment.id, name: original.originalName, kind: attachment.kind,
        mimeType: original.mimeType, byteSize: original.byteSize,
        file: { uri: giftOriginalUri(original), name: original.originalName, mimeType: original.mimeType },
        gift: { id: gift.id, revision: gift.revision, dataEpoch: epoch, attachmentId: attachment.id, originalId: original.id } });
    }
  };
  const resolveSource = async (source: Source) => {
    await ready();
    if (source.record) {
      const record = await getFileImportRecord(source.record.cacheId); await ready();
      if (!record || record.archivedAt !== undefined || record.movedToCacheId !== undefined
        || record.cacheId !== source.fileId || record.uri !== source.file.uri || record.name !== source.file.name
        || JSON.stringify(record) !== JSON.stringify(source.record)) throw Error('gift-preparation-source-changed');
    } else if (source.gift) {
      const view = await loadGiftView(source.gift.id, 'I'); await ready();
      if (!view?.revealed || view.gift.revision !== source.gift.revision) throw Error('gift-preparation-source-changed');
      const attachment = view.gift.attachments.find(item => item.id === source.gift!.attachmentId);
      if (!attachment || attachment.kind !== source.kind
        || attachment.original.id !== source.gift.originalId || giftOriginalUri(attachment.original) !== source.file.uri
        || attachment.original.mimeType !== source.mimeType || attachment.original.byteSize !== source.byteSize) throw Error('gift-preparation-source-changed');
    } else throw Error('gift-preparation-source-changed');
    await fileInfo(source.file, source.byteSize); return source;
  };
  const boundGift = async (giftId: string) => {
    const token = bindings.get(giftId);
    if (!token) throw Error('gift-preparation-view-required');
    const view = await loadGiftView(giftId, 'I'); await ready();
    if (!view?.revealed || view.gift.sender !== 'I') throw Error('gift-sender-only');
    if (view.gift.revision !== token.revision) throw Error('gift-stale-version');
    return view.gift;
  };
  const remember = (gift: GiftRecord) => {
    bindings.set(gift.id, { id: gift.id, revision: gift.revision, dataEpoch: epoch }); bindGiftSources(gift); emitGiftChanges();
  };
  const preparing = (gift: GiftRecord) => {
    if (gift.openedAt !== null || gift.receptionStatus === 'opened') throw Error('gift-original-frozen');
    if (gift.deliveryStatus === 'delivered') throw Error('gift-withdraw-before-edit');
    if (gift.deliveryStatus === 'scheduled') throw Error('gift-cancel-before-edit');
  };

  return {
    exportCheckpoint(scope?: { giftIds: readonly string[]; fileIds: readonly string[] }): GiftPreparationCheckpoint {
      return copy({ dataEpoch: epoch, gifts: [...bindings.values()].filter(token => !scope || scope.giftIds.includes(token.id)),
        sources: [...sources.values()].filter(source => !scope || scope.fileIds.includes(source.fileId)) });
    },
    view(giftId?: string, selectBindings?: (facts: GiftPreparationView) => { giftIds: readonly string[]; fileIds: readonly string[] }): Promise<GiftPreparationView> { return run(async () => {
      if (giftId !== undefined && !id(giftId)) throw Error('gift-invalid-id');
      const one = giftId ? await loadGiftView(giftId, 'I') : null;
      const gifts = giftId ? one ? [one] : [] : await listGiftViews('I'); await ready();
      const offered = new Map<string, Source>(), htmlSources: GiftPreparationView['htmlSources'] = [];
      for (const view of gifts) if (view.revealed) bindGiftSources(view.gift, offered);
      for (const record of await listRecentFileImports(100)) {
        const mimeType = record.mimeType ?? imageMime[record.extension.toLowerCase()];
        if (record.archivedAt !== undefined || record.movedToCacheId !== undefined || !mimeType?.startsWith('image/')
          || record.kind !== 'image' && !imageMime[record.extension.toLowerCase()]) continue;
        offered.set(record.cacheId, { fileId: record.cacheId, name: record.name, kind: 'image', mimeType,
          byteSize: record.size ?? -1, file: { uri: record.uri, name: record.name, mimeType }, record: copy(record) });
      }
      const available = new Map<string, Source>();
      for (const [key, source] of offered) {
        try { source.byteSize = await fileInfo(source.file, source.byteSize < 0 ? undefined : source.byteSize); }
        catch (error) { if (error instanceof Error && ['gift-original-missing', 'gift-preparation-source-changed'].includes(error.message)) continue; throw error; }
        available.set(key, source);
        if (giftId && source.kind === 'html' && source.gift?.id === giftId) {
          const text = await FileSystem.readAsStringAsync(source.file.uri, { encoding: FileSystem.EncodingType.UTF8 });
          await resolveSource(source);
          let through = Math.min(12000, text.length);
          if (through < text.length && /[\uD800-\uDBFF]/.test(text[through - 1])) through--;
          htmlSources.push({ attachmentId: source.gift.attachmentId, originalId: source.gift.originalId,
            content: text.slice(0, through), through, total: text.length, complete: through === text.length });
        }
      }
      await ready();
      const facts = { gifts: copy(gifts), files: [...available.values()].map(({ fileId, name, kind, mimeType, byteSize }) => ({ fileId, name, kind, mimeType, byteSize })), htmlSources };
      const scope = selectBindings?.(facts);
      for (const view of gifts) if (view.revealed && view.gift.sender === 'I' && (!scope || scope.giftIds.includes(view.gift.id)))
        bindings.set(view.gift.id, { id: view.gift.id, revision: view.gift.revision, dataEpoch: epoch });
      for (const [key, source] of available) if (!scope || scope.fileIds.includes(key)) sources.set(key, copy(source));
      return facts;
    }); },
    prepare(value: GiftPreparationInput): Promise<GiftRecord> {
      const contents = copy(value);
      return run(async () => {
        if (!contents || typeof contents.title !== 'string' || typeof contents.note !== 'string' || !Array.isArray(contents.attachments)
          || contents.giftId !== undefined && !id(contents.giftId)) throw Error('gift-invalid-draft');
        let gift: GiftRecord | undefined, savedGift: GiftRecord | undefined, error: unknown, cleanupFailed = 0;
        const temporary: string[] = [], used: Source[] = [];
        try {
          gift = contents.giftId ? await boundGift(contents.giftId) : await createGiftDraft('I');
          if (!contents.giftId) remember(gift);
          preparing(gift);
          const attachments: GiftDraftAttachmentInput[] = [];
          const getSource = async (fileId: string) => {
            const source = sources.get(fileId); if (!source) throw Error('gift-preparation-file-not-offered');
            const actual = await resolveSource(source); used.push(actual); return actual;
          };
          for (const item of contents.attachments) {
            await ready();
            if (item.kind === 'keep') {
              if (!gift.attachments.some(attachment => attachment.id === item.attachmentId)) throw Error('gift-attachment-not-owned');
              attachments.push({ existingId: item.attachmentId });
            } else if (item.kind === 'file') {
              const source = await getSource(item.fileId); attachments.push({ kind: source.kind, file: source.file });
            } else if (item.kind === 'url') attachments.push({ kind: 'url', url: item.url });
            else if (item.kind === 'html') {
              if (!id(item.name) || !/^[^/\\\0]+\.html?$/i.test(item.name) || typeof item.html !== 'string' || !item.html.trim()) throw Error('gift-invalid-html');
              if (!FileSystem.cacheDirectory) throw Error('gift-storage-unavailable');
              const uri = `${FileSystem.cacheDirectory}gift-preparation-${randomUUID()}.html`; temporary.push(uri);
              await writeStringFileSafely(uri, item.html, { encoding: FileSystem.EncodingType.UTF8, minimumBytes: 1 }); await ready();
              attachments.push({ kind: 'html', file: { uri, name: item.name, mimeType: 'text/html' } });
            } else throw Error('gift-invalid-attachment');
          }
          let cover = gift.cover ? { existingOriginalId: gift.cover.id } : null;
          let coverSource: Source | undefined;
          if (contents.coverFileId === null) cover = null;
          else if (contents.coverFileId !== undefined) {
            coverSource = await getSource(contents.coverFileId);
            if (coverSource.kind !== 'image') throw Error('gift-invalid-cover');
          }
          await boundGift(gift.id); for (const source of used) await resolveSource(source); await ready();
          savedGift = (await saveGiftDraft(gift, { title: contents.title, note: contents.note, attachments,
            cover: coverSource ? { file: coverSource.file } : cover })).gift;
          remember(savedGift);
          for (const source of used) if (source.gift?.id !== gift.id) await resolveSource(source);
          await ready();
        } catch (cause) { error = cause; }
        finally { for (const uri of temporary) try { await FileSystem.deleteAsync(uri, { idempotent: true }); } catch { cleanupFailed++; } }
        if (!error) try { await ready(); } catch (cause) { error = cause; }
        if (error) throw failure(error, gift?.id ?? contents.giftId, savedGift, cleanupFailed);
        if (cleanupFailed) throw new GiftPreparationError('gift-preparation-cleanup-failed', gift?.id, savedGift, cleanupFailed);
        return savedGift!;
      });
    },
    supplement(value: { giftId: string; attachments: readonly Exclude<GiftPreparationAttachment, { kind: 'keep' }>[] }): Promise<GiftRecord> {
      const contents = copy(value);
      return run(async () => {
        if (!contents || !id(contents.giftId) || !Array.isArray(contents.attachments) || !contents.attachments.length) throw Error('gift-invalid-arguments');
        let savedGift: GiftRecord | undefined, error: unknown, cleanupFailed = 0;
        const temporary: string[] = [], used: Source[] = [];
        try {
          const gift = await boundGift(contents.giftId);
          if (gift.deliveryStatus !== 'delivered' || gift.receptionStatus !== 'opened' || gift.openedAt === null) throw Error('gift-not-opened');
          const attachments: GiftSupplementAttachmentInput[] = [];
          for (const item of contents.attachments) {
            await ready();
            if (item.kind === 'file') {
              const source = sources.get(item.fileId); if (!source) throw Error('gift-preparation-file-not-offered');
              const actual = await resolveSource(source); used.push(actual);
              attachments.push({ kind: actual.kind, file: actual.file });
            } else if (item.kind === 'url') attachments.push({ kind: 'url', url: item.url });
            else if (item.kind === 'html') {
              if (!id(item.name) || !/^[^/\\\0]+\.html?$/i.test(item.name) || typeof item.html !== 'string' || !item.html.trim()) throw Error('gift-invalid-html');
              if (!FileSystem.cacheDirectory) throw Error('gift-storage-unavailable');
              const uri = `${FileSystem.cacheDirectory}gift-preparation-${randomUUID()}.html`; temporary.push(uri);
              await writeStringFileSafely(uri, item.html, { encoding: FileSystem.EncodingType.UTF8, minimumBytes: 1 }); await ready();
              attachments.push({ kind: 'html', file: { uri, name: item.name, mimeType: 'text/html' } });
            } else throw Error('gift-invalid-attachment');
          }
          await boundGift(gift.id); for (const source of used) await resolveSource(source); await ready();
          savedGift = (await appendGiftAttachments(gift, 'I', attachments)).gift;
          remember(savedGift);
          for (const source of used) await resolveSource(source);
          await ready();
        } catch (cause) { error = cause; }
        finally { for (const uri of temporary) try { await FileSystem.deleteAsync(uri, { idempotent: true }); } catch { cleanupFailed++; } }
        if (!error) try { await ready(); } catch (cause) { error = cause; }
        if (error) throw failure(error, contents.giftId, savedGift, cleanupFailed);
        if (cleanupFailed) throw new GiftPreparationError('gift-preparation-cleanup-failed', contents.giftId, savedGift, cleanupFailed);
        return savedGift!;
      });
    },
    deliver(value: { giftId: string; mode: 'now' | 'schedule' | 'cancel'; at?: number }): Promise<GiftRecord> {
      const request = { ...value };
      return run(async () => {
        let savedGift: GiftRecord | undefined;
        try {
          let gift = await boundGift(request.giftId);
          if (request.mode === 'cancel') savedGift = await cancelGiftSchedule(gift);
          else {
            preparing(gift);
            if (!gift.title.trim() || !gift.attachments.length) throw Error('gift-not-ready');
            for (const original of giftOriginals(gift)) await fileInfo({ uri: giftOriginalUri(original), name: original.originalName, mimeType: original.mimeType }, original.byteSize);
            await ready();
            if (request.mode === 'now') savedGift = await recordGiftDelivery(gift);
            else if (request.mode === 'schedule') {
              if (request.at === undefined || !Number.isFinite(request.at) || request.at <= 0 || !Number.isFinite(new Date(request.at).getTime())) throw Error('gift-invalid-time');
              gift = (await saveGiftDraft(gift, { title: gift.title, note: gift.note, attachments: gift.attachments.map(item => ({ existingId: item.id })),
                cover: gift.cover ? { existingOriginalId: gift.cover.id } : null,
                deliveryPlan: { at: request.at, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } })).gift;
              savedGift = gift; remember(gift); await ready(); savedGift = await scheduleGiftDelivery(gift);
            } else throw Error('gift-invalid-delivery');
          }
          remember(savedGift); await ready(); return savedGift;
        } catch (error) { throw failure(error, request.giftId, savedGift); }
      });
    },
  };
}
