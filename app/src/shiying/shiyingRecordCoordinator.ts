import {
  captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import type { ShiyingRecordImageV1, ShiyingRecordV1 } from './shiyingJournalContract';
import { createShiyingRecordContentHash } from './shiyingJournalContract';
import { deleteShiyingRecord, getShiyingRecordById } from './shiyingJournalStore';
import {
  createRecordForWriting, openRecordForWriting, saveRecordForWriting,
  settleDueRecords, getNextRecordDeadline,
} from './shiyingRecordStore';
import { collectUnusedShiyingRecordImages, importShiyingRecordImage } from './shiyingRecordImages';
import { getShiyingRecordCreationBasis } from './shiyingRecordPolicy';
import { registerShiyingBackupParticipant } from './shiyingBackupRuntime';

export type ShiyingDraftContent = { body: string; images: ShiyingRecordImageV1[] };
type RecordPorts = {
  create: typeof createRecordForWriting;
  open: typeof openRecordForWriting;
  save: typeof saveRecordForWriting;
  settle: typeof settleDueRecords;
  deadline: typeof getNextRecordDeadline;
  remove: typeof deleteShiyingRecord;
  read: typeof getShiyingRecordById;
  importImage: typeof importShiyingRecordImage;
  collect: typeof collectUnusedShiyingRecordImages;
  now: () => number;
  captureEpoch?: () => number | null;
  protect: <T>(operation: () => Promise<T>, epoch?: number | null) => Promise<T>;
};

/** One queue covers file import, its DB reference, and collection together. */
export function createShiyingRecordCoordinator(ports: RecordPorts) {
  let tail: Promise<unknown> = Promise.resolve();
  let editor: ShiyingRecordV1 | null = null;
  let editorLease = 0;
  const listeners = new Set<(change: 'changed' | 'finalized') => void>();
  const publish = (change: 'changed' | 'finalized' = 'changed') => {
    for (const listener of listeners) {
      try { listener(change); } catch { /* A view refresh cannot undo an already saved record. */ }
    }
  };
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = tail;
    // Freeze identity now, but acquire shared protection only after the domain queue.
    // Holding shared while waiting for a backup barrier would prevent its exclusive lock.
    const epoch = ports.captureEpoch?.();
    const task = previous.catch(() => undefined).then(() => ports.protect(operation, epoch));
    tail = task;
    return task;
  }
  function backupBarrier<T>(operation: () => Promise<T>): Promise<T> {
    const task = tail.catch(() => undefined).then(operation);
    tail = task;
    return task;
  }
  const liveId = () => editor?.status === 'draft' ? editor.id : null;
  async function save(content: ShiyingDraftContent, finish: boolean) {
    if (!editor || editor.status !== 'draft') throw new Error('shiying_record_editor_unavailable');
    const previousImages = editor.images;
    const result = await ports.save({
      id: editor.id, expectedContentHash: createShiyingRecordContentHash(editor),
      ...content, now: ports.now(), finish,
    });
    editor = finish ? null : result;
    publish(result?.status === 'finalized' ? 'finalized' : 'changed');
    if (!result || previousImages.some(image => !result.images.some(next => next.contentHash === image.contentHash))) {
      await ports.collect().catch(() => undefined);
    }
    return result;
  }
  return {
    subscribe(listener: (change: 'changed' | 'finalized') => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getLiveEditorId: liveId,
    backupBarrier,
    invalidateForRestore: () => { editor = null; editorLease += 1; },
    create: (date: 'today' | 'yesterday' = 'today') => {
      const startedAt = ports.now();
      const basis = getShiyingRecordCreationBasis(startedAt, date);
      const yesterday = date === 'yesterday' ? basis.recordDate : undefined;
      return serial(async () => {
        const record = await ports.create(startedAt, date, yesterday, basis);
        editor = record.status === 'draft' ? record : null;
        editorLease += 1; publish(); return record;
      });
    },
    open: (id: string) => serial(async () => {
      const record = await ports.open(id, ports.now(), liveId());
      editor = record?.status === 'draft' ? record : null;
      editorLease += 1;
      publish(record?.status === 'finalized' ? 'finalized' : 'changed'); return record;
    }),
    bindEditor: (recordId: string, expectedRecord?: ShiyingRecordV1) => {
      if (expectedRecord && editor !== expectedRecord) throw new Error('shiying_record_editor_unavailable');
      const lease = editorLease;
      const assertEditor = () => {
        if (editor?.id !== recordId || editorLease !== lease) throw new Error('shiying_record_editor_unavailable');
      };
      assertEditor();
      return {
        save: (content: ShiyingDraftContent, finish = false) => serial(() => { assertEditor(); return save(content, finish); }),
        addImage: (uri: string, content: () => ShiyingDraftContent) => serial(async () => {
          assertEditor();
          if (content().images.length >= 9) throw new Error('shiying_record_image_limit');
          let imported = false;
          try {
            const image = await ports.importImage(recordId, content().images.length, uri);
            imported = true;
            const latest = content();
            return await save({ body: latest.body, images: [...latest.images, image] }, false);
          } catch (error) {
            if (imported && error instanceof Error) Object.assign(error, { imageStage: 'reference' });
            await ports.collect().catch(() => undefined); throw error;
          }
        }),
        detach: () => {
          if (editor?.id === recordId && editorLease === lease) { editor = null; editorLease += 1; publish(); }
        },
      };
    },
    remove: (id: string, updatedAt: number) => serial(async () => {
      const latest = await ports.read(id);
      await ports.remove({ id, deletedAt: Math.max(ports.now(), updatedAt, latest?.updatedAt ?? 0) });
      if (editor?.id === id) { editor = null; editorLease += 1; }
      publish(); await ports.collect().catch(() => undefined);
    }),
    collect: () => serial(ports.collect),
    settle: (options: { notifyFinalized?: boolean } = {}) => serial(async () => {
      const result = await ports.settle(ports.now(), liveId());
      if (result.finalizedIds.length || result.deletedIds.length) publish(result.finalizedIds.length && options.notifyFinalized !== false ? 'finalized' : 'changed');
      return result;
    }),
    nextDeadline: () => serial(() => ports.deadline(ports.now(), liveId())),
  };
}

export const shiyingRecordCoordinator = createShiyingRecordCoordinator({
  create: createRecordForWriting, open: openRecordForWriting, save: saveRecordForWriting,
  settle: settleDueRecords, deadline: getNextRecordDeadline, remove: deleteShiyingRecord,
  read: getShiyingRecordById,
  importImage: importShiyingRecordImage, collect: collectUnusedShiyingRecordImages,
  now: Date.now,
  captureEpoch: captureBackupRestoreDataEpoch,
  protect: <T>(operation: () => Promise<T>, epoch = captureBackupRestoreDataEpoch()) => {
    return runBackupRestoreDataEpochCommit(epoch, operation).then(result => {
      if (!result.committed) throw new Error('shiying_record_restore_busy');
      return result.value;
    });
  },
});

registerShiyingBackupParticipant({ invalidate: shiyingRecordCoordinator.invalidateForRestore });
