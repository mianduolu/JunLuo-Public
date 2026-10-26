import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha2.js';

const FOCUS_ID_CONTEXT = 'junluo.focus.session-id.v1';

function base64Url(bytes: Uint8Array) {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function makeFocusSessionId(input: {
  startedAt: number;
  mode: string;
  userActivity: string;
}) {
  if (!Number.isSafeInteger(input.startedAt) || input.startedAt < 0) {
    throw new Error('focus session startedAt 必须是非负 Unix 毫秒整数。');
  }
  const mode = input.mode.trim();
  const userActivity = input.userActivity.trim();
  if (!mode || !userActivity) {
    throw new Error('focus session identity 缺少 mode 或 userActivity。');
  }
  const canonical = JSON.stringify([
    FOCUS_ID_CONTEXT,
    input.startedAt,
    mode,
    userActivity,
  ]);
  return `focus-${base64Url(sha256(new TextEncoder().encode(canonical)))}`;
}
