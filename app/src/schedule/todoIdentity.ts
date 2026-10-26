import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToBase64Url } from '../sync/syncBase64Url';

export type TodoNaturalIdentityKind =
  | 'generated-todo'
  | 'inhibit-log'
  | 'habit-log'
  | 'goal-progress'
  | 'goal-time-credit'
  | 'day-review'
  | 'week-review';

const TODO_NATURAL_ID_CONTEXT = 'junluo.todo.natural-id.v1';

export function makeTodoNaturalRecordId(
  kind: TodoNaturalIdentityKind,
  parts: readonly string[],
) {
  if (
    !parts.length
    || parts.some((part) => typeof part !== 'string' || part.length < 1)
  ) {
    throw new Error('TODO 自然实体 ID 需要非空字符串组成部分。');
  }
  const canonical = JSON.stringify([
    TODO_NATURAL_ID_CONTEXT,
    kind,
    ...parts,
  ]);
  const digest = bytesToBase64Url(
    sha256(Buffer.from(canonical, 'utf8')),
  );
  return `${kind}-${digest}`;
}
