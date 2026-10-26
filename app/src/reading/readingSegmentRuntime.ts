import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { loadReadingAnnotations, loadReadingChapter, loadReadingLibraryStrict, makeReadingId, resetReadingSegmentWithinWrite, runReadingStoreExclusive, saveReadingChapterWithinWrite as saveReadingChapter, saveReadingLibrary, upsertReadingAnnotations } from './readingStore';
import { readingSegmentSourceVersion } from './readingDailyPolicy';
import type { DailyReadingActivity, ReadingBook, ReadingChapter, ReadingSegmentMeta, ReadingSegmentRequest } from './readingTypes';
import type { ParsedReadingAnnotationResponse } from './readingAi';
import type { ReadingTransport } from './readingAi';
import { releaseReadingBatchBudget } from '../ai/aiCallBudget';
import { readingRequestFailureMessage } from './readingRequestFailure';

const runtimeId = makeReadingId('reading-runtime');
const active = new Set<string>();
// Keep only this process's original return until the existing local check can finish it.
// This is not durable evidence: restart/epoch/source replacement discards it, never regenerates it.
type LocalSettlement = {
  bookId: string; chapterIndex: number; segmentIndex: number; epoch: number;
  requestId: string; sourceVersion: string; runtimeId: string; entries: number;
  result?: ReadingSegmentRequest['result']; failure?: string; transportStarted: boolean;
};
const localSettlements = new Map<string, LocalSettlement>();

export function canRegenerateReadingSegment(bookId: string, chapterIndex: number, segment?: ReadingSegmentMeta | null) {
  if (!segment) return false;
  const key = `${bookId}:${chapterIndex}:${segment.segmentIndex}`;
  const local = localSettlements.get(key);
  if (active.has(key) || local && canCommitBackupRestoreDataEpoch(local.epoch)
    && local.requestId === segment.request?.id && local.sourceVersion === segment.request.sourceVersion) return false;
  return segment.status === 'done' || !!(segment.request && (
    segment.request.save?.outcome === 'exhausted' || (segment.request.save?.attempts ?? 0) >= 4
    || !segment.request.result && (segment.request.transportStartedAt || segment.request.save?.attempts)));
}

/** Explicit existing regeneration only: no model request, no opportunity refund, no progress advance. */
export async function prepareReadingRegeneration(bookId: string, expectedChapter: ReadingChapter,
  expectedSegment: ReadingSegmentMeta, epoch = captureBackupRestoreDataEpoch()): Promise<ReadingChapter> {
  return runReadingStoreExclusive(async () => {
    const committed = await runBackupRestoreDataEpochCommit(epoch, async () => {
      const books = await loadReadingLibraryStrict();
      const book = books.find(b => b.id === bookId);
      if (!book) throw new Error('reading-source-deleted');
      const chapter = await loadReadingChapter(bookId, expectedChapter.index, true);
      const segment = chapter?.segmentsMeta.find(s => s.segmentIndex === expectedSegment.segmentIndex);
      if (!chapter || !segment || readingSegmentSourceVersion(chapter, segment)
        !== readingSegmentSourceVersion(expectedChapter, expectedSegment)) throw new Error('reading-source-changed');
      if (JSON.stringify(segment.request) !== JSON.stringify(expectedSegment.request)
        || segment.status !== expectedSegment.status || segment.resultOperationId !== expectedSegment.resultOperationId
        || segment.resultActivityId !== expectedSegment.resultActivityId) throw new Error('reading-request-replaced');
      if (!canRegenerateReadingSegment(bookId, chapter.index, segment)) throw new Error('reading-regeneration-unavailable');
      // Clearing only the old reservation first is safe even if the following chapter write fails:
      // the old request still blocks automatic transport. Never return its already-spent opportunity.
      if (segment.request && book.iReading?.requestReservation?.id === segment.request.id) {
        try {
          await saveReadingLibrary(books.map(b => b.id === bookId ? { ...b,
            iReading: { ...b.iReading!, requestReservation: undefined, updatedAt: Date.now() } } : b));
        } catch (error) {
          const saved = (await loadReadingLibraryStrict()).find(b => b.id === bookId);
          if (!saved || saved.iReading?.requestReservation !== undefined) throw error;
        }
      }
      if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('reading-source-restore');
      const operationId = makeReadingId('reading-result');
      try {
        const reset = await resetReadingSegmentWithinWrite(bookId, chapter.index, segment.segmentIndex, operationId);
        if (!reset) throw new Error('reading-source-deleted');
        return reset;
      } catch (error) {
        const saved = await loadReadingChapter(bookId, chapter.index, true);
        const target = saved?.segmentsMeta.find(s => s.segmentIndex === segment.segmentIndex);
        if (!saved || target?.request?.id !== operationId || target.status !== 'pending'
          || target.request.sourceVersion !== readingSegmentSourceVersion(chapter, segment)) throw error;
        return saved;
      }
    });
    if (!committed.committed || !canCommitBackupRestoreDataEpoch(epoch)) throw new Error('reading-source-restore');
    return committed.value;
  });
}

export function pendingReadingSettlement(books: readonly ReadingBook[]) {
  for (const [key, pending] of localSettlements) {
    const book = books.find(b => b.id === pending.bookId);
    if (!book || !canCommitBackupRestoreDataEpoch(pending.epoch)) { localSettlements.delete(key); continue; }
    if (!active.has(key)) return book;
  }
  return undefined;
}

export async function resumeReadingSettlement(book: ReadingBook, onUnstarted?: (requestId: string) => Promise<void>) {
  const pending = [...localSettlements.values()].find(p => p.bookId === book.id && canCommitBackupRestoreDataEpoch(p.epoch));
  if (!pending) return { status: 'invalidated' as const };
  const key = `${book.id}:${pending.chapterIndex}:${pending.segmentIndex}`;
  if (active.has(key)) return { status: 'busy' as const };
  pending.entries += 1;
  try {
    const chapter = await loadReadingChapter(book.id, pending.chapterIndex, true);
    const segment = chapter?.segmentsMeta.find(s => s.segmentIndex === pending.segmentIndex);
    if (!chapter || !segment) { localSettlements.delete(key); return { status: 'invalidated' as const }; }
    return await runReadingSegment({ book, chapter, segment, kind: segment.request?.kind ?? 'daily', localOnly: true, onUnstarted,
      request: async () => { throw new Error('reading-local-settlement-cannot-request'); } });
  } catch (error) {
    if (error instanceof Error && ['reading-source-deleted', 'reading-source-changed', 'reading-source-restore'].includes(error.message)) {
      localSettlements.delete(key);
    }
    throw error;
  } finally {
    if (pending.entries >= 4 && localSettlements.get(key) === pending) localSettlements.delete(key);
  }
}

export async function retryReadingSave<T>(save: () => Promise<T>): Promise<T> {
  let failure: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try { return await save(); } catch (error) { failure = error; }
  }
  throw failure;
}

/** Manual invitations and background reading acquire the same persisted segment. No lock spans network. */
export async function runReadingSegment(input: {
  book: ReadingBook; chapter: ReadingChapter; segment: ReadingSegmentMeta; kind: 'manual' | 'daily';
  dataEpoch?: number | null;
  localOnly?: boolean;
  beforeTransport?: (requestId: string, transport?: ReadingTransport) => Promise<void>;
  onUnstarted?: (requestId: string) => Promise<void>;
  request: (beforeTransport: (transport?: ReadingTransport) => Promise<void>) => Promise<ParsedReadingAnnotationResponse>;
}) {
  const epoch = input.dataEpoch ?? captureBackupRestoreDataEpoch();
  if (epoch === null) return { status: 'invalidated' as const };
  const sourceVersion = readingSegmentSourceVersion(input.chapter, input.segment);
  const key = `${input.book.id}:${input.chapter.index}:${input.segment.segmentIndex}`;
  let local: LocalSettlement | undefined;
  let claimedSchedule: DailyReadingActivity['schedule'];
  const readSource = async () => {
    if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('reading-source-restore');
    if (!(await loadReadingLibraryStrict()).some(b => b.id === input.book.id)) throw new Error('reading-source-deleted');
    const chapter = await loadReadingChapter(input.book.id, input.chapter.index, true);
    const segment = chapter?.segmentsMeta.find(s => s.segmentIndex === input.segment.segmentIndex);
    if (!chapter || !segment || readingSegmentSourceVersion(chapter, segment) !== sourceVersion) throw new Error('reading-source-changed');
    return { chapter, segment };
  };
  const claim = await runReadingStoreExclusive(async () => {
    if (active.has(key)) return null;
    const { chapter, segment } = await readSource();
    local = localSettlements.get(key);
    if (local && (local.epoch !== epoch || local.sourceVersion !== sourceVersion
      || segment.request?.id !== local.requestId || segment.request.runtimeId !== local.runtimeId)) {
      localSettlements.delete(key); local = undefined;
    }
    if (segment.status === 'done' && segment.sourceVersion === sourceVersion && segment.resultOperationId) {
      const notes = await loadReadingAnnotations(input.book.id, chapter.index, true);
      if (![...notes.annotations, ...notes.summaries].some(note => note.resultOperationId === segment.resultOperationId
        && note.sourceVersion === sourceVersion)) throw new Error('reading-result-unavailable');
      localSettlements.delete(key);
      return 'saved' as const;
    }
    const activity = (await loadReadingLibraryStrict()).find(book => book.id === input.book.id)?.iReading?.activity;
    claimedSchedule = activity?.status !== 'ended' ? activity?.schedule : undefined;
    const existing = segment.request;
    if (input.localOnly && !local && !(existing?.result && existing.sourceVersion === sourceVersion)) return 'invalidated' as const;
    if (existing?.sourceVersion === sourceVersion && existing.save && existing.save.attempts >= 4) {
      localSettlements.delete(key); throw new Error('reading-save-exhausted');
    }
    const request: ReadingSegmentRequest = existing?.sourceVersion === sourceVersion && (existing.result || existing.save || existing.transportStartedAt) ? existing
      : { id: makeReadingId('reading-result'), runtimeId, startedAt: Date.now(), sourceVersion, kind: input.kind,
        resultActivityId: activity && activity.status !== 'ended' ? activity.id : null,
        ...(activity?.status !== 'ended' && activity?.memoryIngestionVersion === 1 ? { memoryIngestionVersion: 1 as const } : {}),
        save: { attempts: 0, phase: 'result', outcome: 'pending', resultRetained: false } };
    // A pre-existing transport without a durable return is unresolved, not permission to pay again.
    if (!request.save && request.transportStartedAt) request.save = { attempts: 0, phase: 'result', outcome: 'unknown', resultRetained: false };
    if (request.save?.attempts === 0 && !request.transportStartedAt) {
      request.runtimeId = runtimeId;
      request.resultActivityId = activity && activity.status !== 'ended' ? activity.id : null;
      request.memoryIngestionVersion = activity && activity.status !== 'ended' && activity.memoryIngestionVersion === 1 ? 1 : undefined;
    }
    if (!local) await retryReadingSave(() => saveReadingChapter({ ...chapter, segmentsMeta: chapter.segmentsMeta.map(s => s.segmentIndex === segment.segmentIndex
      ? { ...s, status: 'annotating', request, updatedAt: Date.now() } : s) }));
    active.add(key);
    return request;
  });
  if (!claim) return { status: 'busy' as const };
  if (claim === 'invalidated') return { status: 'invalidated' as const };
  if (claim === 'saved') return { status: 'saved' as const, transportStarted: false };
  let transportStarted = local?.transportStarted ?? !!claim.transportStartedAt;
  let legal = claim.result ?? local?.result;
  let requestInvoked = false;
  let phase = 'source-check';
  const keepLocal = (failure?: string) => {
    local ??= { bookId: input.book.id, chapterIndex: input.chapter.index, segmentIndex: input.segment.segmentIndex,
      epoch, requestId: claim.id, sourceVersion, runtimeId: claim.runtimeId, entries: 1, transportStarted };
    local.result = legal; local.failure = failure; local.transportStarted = transportStarted;
    localSettlements.set(key, local);
  };
  if (local && !input.localOnly) local.entries += 1;
  try {
    if (local?.failure) throw new Error(local.failure);
    if (!legal && claim.save && (claim.save.attempts > 0 || claim.transportStartedAt)) throw new Error('reading-result-unavailable');
    if (!legal) {
      requestInvoked = true;
      const parsed = await input.request(async transport => {
        await readSource();
        if (claimedSchedule && claim.resultActivityId && !await (await import('../schedule/ownScheduleExecution'))
          .isOwnScheduledReadingRequestAllowed(claimedSchedule, claim.resultActivityId)) throw new Error('reading-activity-changed');
        claim.transportStartedAt = Date.now();
        claim.save = { attempts: 0, phase: 'result', outcome: 'unknown', resultRetained: false };
        await runReadingStoreExclusive(async () => {
          const { chapter, segment } = await readSource();
          if (segment.request?.id !== claim.id) throw new Error('reading-request-replaced');
          await retryReadingSave(() => saveReadingChapter({ ...chapter, segmentsMeta: chapter.segmentsMeta.map(s => s.segmentIndex === segment.segmentIndex
            ? { ...s, request: { ...claim } } : s) }));
        });
        // Complete all local preparation before the budget/owner's final transport admission.
        await input.beforeTransport?.(claim.id, transport);
        transportStarted = true;
      });
      legal = { annotations: parsed.annotations, summary: parsed.summary, savedAt: Date.now() };
      keepLocal();
    }
    // Each admitted attempt may finish all missing stages. Its allowance survives process restarts.
    await runReadingStoreExclusive(async () => {
      const result = await runBackupRestoreDataEpochCommit(epoch, async () => {
        const completed = (segment: ReadingSegmentMeta) => segment.status === 'done'
          && segment.resultOperationId === claim.id && segment.sourceVersion === sourceVersion
          && (claim.memoryIngestionVersion !== 1 || segment.memoryIngestionVersion === 1 && segment.resultActivityId === claim.resultActivityId);
        const writeRequest = async (request: ReadingSegmentRequest) => {
          const current = await readSource();
          if (current.segment.request?.id !== claim.id) throw new Error('reading-request-replaced');
          await saveReadingChapter({ ...current.chapter, segmentsMeta: current.chapter.segmentsMeta.map(s =>
            s.segmentIndex === current.segment.segmentIndex ? { ...s, request, updatedAt: Date.now() } : s) });
        };
        for (;;) {
          const current = await readSource();
          if (completed(current.segment)) return;
          if (current.segment.request?.id !== claim.id) throw new Error('reading-request-replaced');
          const savedRequest = current.segment.request;
          const attempts = savedRequest.save?.attempts ?? 0;
          if (attempts >= 4) throw new Error('reading-save-exhausted');
          const admitted: ReadingSegmentRequest = { ...savedRequest, save: { attempts: attempts + 1,
            phase: savedRequest.result ? 'annotations' : 'result', outcome: 'unknown', resultRetained: !!savedRequest.result } };
          phase = 'attempt-record';
          try { await writeRequest(admitted); }
          catch (error) {
            // A lost acknowledgement is not permission to spend an unrecorded attempt.
            const checked = await readSource();
            if (checked.segment.request?.id !== claim.id || checked.segment.request.save?.attempts !== attempts + 1) throw error;
          }
          try {
            phase = 'result-record';
            if (!savedRequest.result) await writeRequest({ ...admitted, result: legal!,
              save: { ...admitted.save!, phase: 'annotations', resultRetained: true } });
            phase = 'annotations';
            const notes = await loadReadingAnnotations(input.book.id, current.chapter.index, true);
            const annotations = notes.annotations.filter(item => item.resultOperationId === claim.id && item.sourceVersion === sourceVersion);
            const summary = notes.summaries.find(item => item.resultOperationId === claim.id && item.sourceVersion === sourceVersion);
            const notesComplete = annotations.length === legal!.annotations.length
              && legal!.annotations.every((item, index) => annotations.some(note => note.id === `${claim.id}:annotation:${index}`
                && note.p === item.p && note.text === item.text.trim()
                && (claim.memoryIngestionVersion !== 1 || note.memoryIngestionVersion === 1 && note.resultActivityId === claim.resultActivityId)))
              && (!legal!.summary.trim() || summary?.summary === legal!.summary.trim()
                && (claim.memoryIngestionVersion !== 1 || summary.memoryIngestionVersion === 1 && summary.resultActivityId === claim.resultActivityId));
            if (!notesComplete) await upsertReadingAnnotations(input.book.id, current.chapter.index, current.segment.segmentIndex,
              legal!.annotations, legal!.summary, { operationId: claim.id, sourceVersion, createdAt: legal!.savedAt,
                resultActivityId: claim.resultActivityId, memoryIngestionVersion: claim.memoryIngestionVersion });
            const latest = await readSource();
            phase = 'completion-record';
            await saveReadingChapter({ ...latest.chapter, segmentsMeta: latest.chapter.segmentsMeta.map(s => s.segmentIndex === current.segment.segmentIndex
              ? { ...s, status: 'done', sourceVersion, resultOperationId: claim.id, resultActivityId: claim.resultActivityId,
                memoryIngestionVersion: claim.memoryIngestionVersion,
                request: { ...admitted, result: undefined, save: { ...admitted.save!, phase: 'done', outcome: 'complete', resultRetained: true } },
                errorMessage: undefined, updatedAt: legal!.savedAt } : s) });
            return;
          } catch (error) {
            phase = 'save-reconcile';
            // Re-read before retrying. Unavailable records stop this entry rather than causing blind writes.
            const latest = await readSource();
            if (completed(latest.segment)) return;
            if (latest.segment.request?.id !== claim.id) throw new Error('reading-request-replaced');
            await loadReadingAnnotations(input.book.id, latest.chapter.index, true);
            const request = latest.segment.request;
            await writeRequest({ ...request, save: { ...admitted.save!, resultRetained: !!request.result,
              phase: request.result ? 'annotations' : 'result', outcome: attempts + 1 >= 4 ? 'exhausted' : 'pending' } });
            if (attempts + 1 >= 4) throw error;
          }
        }
      });
      if (!result.committed) throw new Error('reading-source-restore');
    });
    localSettlements.delete(key);
    return { status: 'saved' as const, operationId: claim.id, sourceVersion, transportStarted };
  } catch (error) {
    if (error instanceof Error && ['reading-source-deleted', 'reading-source-changed', 'reading-source-restore', 'reading-request-replaced'].includes(error.message)) {
      localSettlements.delete(key);
      throw error;
    }
    const failure = local?.failure ?? readingRequestFailureMessage(error);
    if ((requestInvoked || local?.failure) && !legal && (!claim.save || claim.save.attempts === 0) && canCommitBackupRestoreDataEpoch(epoch)) {
      keepLocal(failure);
      try {
        if (!transportStarted) await retryReadingSave(async () => { await input.onUnstarted?.(claim.id); });
        await runReadingStoreExclusive(async () => {
          const { chapter, segment } = await readSource();
          if (segment.request?.id !== claim.id) return;
          await saveReadingChapter({ ...chapter, segmentsMeta: chapter.segmentsMeta.map(s => s.segmentIndex === segment.segmentIndex
            ? { ...s, status: transportStarted ? 'failed' : 'pending', request: undefined,
              // A failed attempt still belongs to its original activity; only status=done proves a result.
              ...(transportStarted ? { sourceVersion, resultOperationId: claim.id, resultActivityId: claim.resultActivityId,
                memoryIngestionVersion: claim.memoryIngestionVersion } : {}),
              errorMessage: transportStarted ? failure : 'reading-request-deferred', updatedAt: Date.now() } : s) });
        });
        localSettlements.delete(key);
      } catch {
        throw new Error(`reading-failure-record-unavailable:${failure}`);
      }
    } else if (legal) {
      keepLocal();
      // Technical stage only; never persist an exception body or claim an in-memory return is saved.
      await runReadingStoreExclusive(async () => {
        const current = await readSource();
        if (current.segment.request?.id !== claim.id || current.segment.status === 'done') return;
        await saveReadingChapter({ ...current.chapter, segmentsMeta: current.chapter.segmentsMeta.map(s =>
          s.segmentIndex === input.segment.segmentIndex ? { ...s, errorMessage: `reading-save-failed:${phase}` } : s) });
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    // Bounded continuation in this runtime; persisted result attempts retain their original four-save cap.
    if (local && (local.entries >= 4 || !canCommitBackupRestoreDataEpoch(epoch))) localSettlements.delete(key);
    active.delete(key); releaseReadingBatchBudget(claim.id);
  }
}
