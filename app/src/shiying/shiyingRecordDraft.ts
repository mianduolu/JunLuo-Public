import type { ShiyingRecordV1 } from './shiyingJournalContract';
import type { ShiyingDraftContent } from './shiyingRecordCoordinator';

export type ShiyingDraftSaveStatus = 'saving' | 'saved' | 'failed' | 'conflict';
export type ShiyingDraftSnapshot = ShiyingDraftContent & {
  status: ShiyingDraftSaveStatus; closing: boolean; mediaBusy: boolean;
};
type DraftPorts = {
  save: (content: ShiyingDraftContent, finish: boolean) => Promise<ShiyingRecordV1 | null>;
  addImage: (uri: string, content: () => ShiyingDraftContent) => Promise<ShiyingRecordV1 | null>;
  changed: (snapshot: ShiyingDraftSnapshot) => void;
};

/** Buffer only the current text; the durable record remains the sole saved version. */
export function createShiyingDraftSession(record: ShiyingRecordV1, ports: DraftPorts) {
  let body = record.body, images = record.images;
  let revision = 0, savedRevision = 0, closing = false, mediaBusy = false, closed = false, disposed = false;
  let status: ShiyingDraftSaveStatus = 'saved';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  const content = () => ({ body, images: [...images] });
  const snapshot = (): ShiyingDraftSnapshot => ({ ...content(), status, closing, mediaBusy });
  const emit = () => ports.changed(snapshot());
  const cancelTimer = () => { if (timer) clearTimeout(timer); timer = null; };
  function schedule() {
    cancelTimer();
    if (!closed && !closing && !disposed) timer = setTimeout(() => { timer = null; void flush(false).catch(() => undefined); }, 500);
  }
  function queue<T>(work: () => Promise<T>) {
    const next = tail.catch(() => undefined).then(work); tail = next; return next;
  }
  function failed(error: unknown) {
    status = error instanceof Error && error.message.includes('content_conflict') ? 'conflict' : 'failed';
    closing = false; emit();
  }
  function flush(finish = false): Promise<ShiyingRecordV1 | null> {
    cancelTimer();
    if (closed) return Promise.reject(new Error('shiying_record_session_closed'));
    if (finish) { closing = true; emit(); }
    return queue(async () => {
      if (closed) throw new Error('shiying_record_session_closed');
      if (!finish && revision === savedRevision && status !== 'failed') return null;
      const sentRevision = revision;
      status = 'saving'; emit();
      try {
        const result = await ports.save(content(), finish);
        savedRevision = sentRevision;
        if (finish) { closed = true; closing = false; cancelTimer(); }
        status = revision === savedRevision ? 'saved' : 'saving'; emit();
        if (!finish && revision !== savedRevision) schedule();
        return result;
      } catch (error) { failed(error); throw error; }
    });
  }
  return {
    snapshot,
    setBody(value: string) {
      if (closed || closing || body === value) return;
      body = value; revision += 1; status = 'saving'; emit(); schedule();
    },
    removeImage(id: string) {
      if (closed || closing || mediaBusy) return Promise.resolve(null);
      images = images.filter(image => image.id !== id).map((image, ordinal) => ({ ...image, ordinal }));
      revision += 1; status = 'saving'; emit(); return flush();
    },
    addImage(uri: string) {
      if (closed || closing || mediaBusy) return Promise.reject(new Error('shiying_record_media_busy'));
      cancelTimer(); mediaBusy = true; emit();
      return queue(async () => {
        if (closed) throw new Error('shiying_record_session_closed');
        let sentBody = '';
        try {
          const result = await ports.addImage(uri, () => { sentBody = body; return content(); });
          if (closed) throw new Error('shiying_record_session_closed');
          if (!result) throw new Error('shiying_record_image_save_failed');
          images = result.images; revision += 1;
          if (body === sentBody) savedRevision = revision;
          status = revision === savedRevision ? 'saved' : 'saving';
          return result;
        } catch (error) {
          // A failed attachment is reported separately; saved text remains saved.
          if (revision === savedRevision) { status = 'saved'; emit(); }
          else failed(error);
          throw error;
        }
        finally { mediaBusy = false; emit(); if (status === 'saving') schedule(); }
      });
    },
    flush,
    invalidate() { closed = true; disposed = true; body = ''; images = []; cancelTimer(); },
    dispose() { disposed = true; cancelTimer(); },
  };
}
