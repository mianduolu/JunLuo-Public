import { NativeModules, Platform } from 'react-native';

// Hosting limit, not the per-request model timeout. No requests are replayed.
export const CHAT_REPLY_BACKGROUND_LIMIT_MS = 15 * 60_000;
const waiting = new Map<string, Promise<void>>();
const activeReplies = new Set<string>();
let sequence = 0;
export function hasActiveChatReplyBackground() { return activeReplies.size > 0; }

export function beginChatReplyBackground() {
  const native = Platform.OS === 'android' ? NativeModules.JunLuoChatReplyBackground : undefined;
  const token = `chat-reply-${Date.now()}-${++sequence}`;
  let resolve!: () => void;
  const done = new Promise<void>(finish => { resolve = finish; });
  activeReplies.add(token);
  if (native?.begin) waiting.set(token, done);
  const timer = setTimeout(() => finish(), CHAT_REPLY_BACKGROUND_LIMIT_MS);
  function finish() {
    if (!activeReplies.delete(token)) return;
    clearTimeout(timer);
    waiting.delete(token);
    resolve();
  }
  // A missing/denied native host must not change foreground reply results.
  try {
    if (native?.begin) Promise.resolve(native.begin(token)).then(started => {
      if (!started) { waiting.delete(token); resolve(); }
    }, () => { waiting.delete(token); resolve(); });
  } catch { waiting.delete(token); resolve(); }
  return finish;
}

// This task only keeps the existing JS work awake. A cold/late invocation has
// no in-memory owner and returns immediately; it cannot generate another reply.
export async function holdChatReplyBackgroundTask(payload: { token?: unknown }) {
  if (typeof payload?.token === 'string') await waiting.get(payload.token);
}
