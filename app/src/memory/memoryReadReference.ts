import type { MemoryRecallItem } from './memoryStore';
import type { MemoryCurrentState } from './memoryCurrentStateStore';
import type { ShiyingMemorySnapshot } from '../shiying/shiyingMemorySource';
import type { PostRecallSnapshot } from '../posts/baiyunPostRecallSource';
import type { PostRecallHit } from './memoryPostRecall';
import type { PostMaterialBinding } from '../posts/baiyunPostMemorySource';

export type CurrentStateReadReference = {
  targetKind: 'current_state'; currentState: MemoryCurrentState; version: string; sourceVersion?: string;
};
export type ShiyingReadReference = {
  targetKind: 'shiying_record'; shiying: ShiyingMemorySnapshot; version: string; sourceVersion?: string;
};
export type PostReadReference = {
  targetKind: 'post'; post: PostRecallSnapshot; version: string; hits?: PostRecallHit[]; excludedRanges?: PostMaterialBinding[];
};
export type MemoryReadReference = MemoryRecallItem | CurrentStateReadReference | ShiyingReadReference | PostReadReference;
export function isPostReference(reference: MemoryReadReference): reference is PostReadReference {
  return 'targetKind' in reference && reference.targetKind === 'post';
}
export function isCurrentStateReference(reference: MemoryReadReference): reference is CurrentStateReadReference {
  return 'targetKind' in reference && reference.targetKind === 'current_state';
}
export function isShiyingReference(reference: MemoryReadReference): reference is ShiyingReadReference {
  return 'targetKind' in reference && reference.targetKind === 'shiying_record';
}
export function isMemoryReference(reference: MemoryReadReference): reference is MemoryRecallItem {
  return 'memory' in reference;
}
export function referenceId(reference: MemoryReadReference) {
  return isCurrentStateReference(reference) ? reference.currentState.id
    : isShiyingReference(reference) ? reference.shiying.recordId : isPostReference(reference) ? reference.post.postId : reference.memory.id;
}
export function referenceKey(reference: MemoryReadReference) {
  return isCurrentStateReference(reference) ? JSON.stringify(['current_state', reference.currentState.id])
    : isShiyingReference(reference) ? JSON.stringify(['shiying_record', reference.shiying.recordId])
      : isPostReference(reference) ? JSON.stringify(['post', reference.post.postId]) : reference.memory.id;
}

// Host-only binding: the existing tool JSON shape carries no extra model fields.
export const currentStateSearchRows = new WeakMap<object, CurrentStateReadReference>();
export const shiyingSearchRows = new WeakMap<object, ShiyingReadReference>();
export const postSearchRows = new WeakMap<object, PostReadReference>();
