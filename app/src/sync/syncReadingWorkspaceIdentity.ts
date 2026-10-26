import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha2.js';

const READING_WORKSPACE_ID_CONTEXT =
  'junluo.reading.workspace.entity-id.v1';

function base64Url(bytes: Uint8Array) {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export type ReadingWorkspaceIdentityKind =
  | 'annotation'
  | 'book'
  | 'chapter'
  | 'note'
  | 'paragraph'
  | 'result-action'
  | 'segment-summary'
  | 'session'
  | 'web-clip';

export function makeReadingWorkspaceEntityId(
  kind: ReadingWorkspaceIdentityKind,
  ...parts: Array<string | number>
) {
  if (!parts.length) {
    throw new Error('reading.workspace identity 缺少组成部分。');
  }
  for (const part of parts) {
    if (
      (typeof part === 'string' && (part.length < 1 || part.length > 4096))
      || (
        typeof part === 'number'
        && (!Number.isSafeInteger(part) || part < 0)
      )
    ) {
      throw new Error('reading.workspace identity 组成部分无效。');
    }
  }
  const canonical = JSON.stringify([
    READING_WORKSPACE_ID_CONTEXT,
    kind,
    ...parts,
  ]);
  return `reading-${kind}-${base64Url(
    sha256(new TextEncoder().encode(canonical)),
  )}`;
}
