import { GIFT_WEB_CHANNEL } from './giftWebDocument';
import type { GiftAttachmentActivity, GiftWebProgress } from './giftTypes';

export type GiftWebReply = { channel: string; sessionId: string; id: number }
  & ({ ok: true; activity: GiftAttachmentActivity } | { ok: false; error: string });

/** One displayed work, shared by native WebView and desktop iframe. */
export function createGiftWebSession(options: {
  sessionId: string; initialActivity: GiftAttachmentActivity;
  save(revision: number, progress: GiftWebProgress): Promise<GiftAttachmentActivity>;
  reset(revision: number): Promise<GiftAttachmentActivity>;
  reply(message: GiftWebReply): void;
  onChange(activity: GiftAttachmentActivity): void;
  onError(error: unknown): void;
}) {
  let activity = options.initialActivity, stopped = false, accepting = true;
  let tail: Promise<unknown> = Promise.resolve();
  let unresolvedWriteError: { value: unknown } | null = null;
  const apply = (next: GiftAttachmentActivity) => { activity = next; unresolvedWriteError = null; if (!stopped) options.onChange(next); return next; };
  const receive = (raw: unknown) => {
    if (stopped || !accepting) return;
    let message: { channel: string; sessionId: string; id: number; type: string; progress: GiftWebProgress };
    try { message = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
    if (!message || message.channel !== GIFT_WEB_CHANNEL || message.sessionId !== options.sessionId
      || !Number.isSafeInteger(message.id) || message.id < 1) return;
    const { id, type, progress } = message;
    if (!['save', 'reset', 'storage-unavailable'].includes(type)) return;
    const response = { channel: GIFT_WEB_CHANNEL, sessionId: options.sessionId, id };
    tail = tail.catch(() => undefined).then(async () => {
      if (type === 'storage-unavailable') throw Error('gift-storage-incompatible');
      return apply(type === 'reset' ? await options.reset(activity.revision) : await options.save(activity.revision, progress));
    }).then(next => { if (!stopped) options.reply({ ...response, ok: true, activity: next }); })
      .catch(error => { unresolvedWriteError = { value: error }; if (!stopped) { options.onError(error); options.reply({ ...response, ok: false,
        error: error instanceof Error ? error.message : 'gift-progress-save-failed' }); } });
  };
  return {
    receive,
    flush: async () => { await tail; if (unresolvedWriteError) throw unresolvedWriteError.value; },
    stop: () => { stopped = true; accepting = false; },
    restart: async () => {
      accepting = false;
      try { await tail; return apply(await options.reset(activity.revision)); }
      catch (error) { accepting = !stopped; if (!stopped) options.onError(error); throw error; }
    },
  };
}
