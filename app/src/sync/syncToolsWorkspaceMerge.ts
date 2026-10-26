import {
  assertToolsWorkspaceMutationV1,
} from './syncToolsWorkspace';
import type { PlainMutationV1 } from './syncProtocol';

function compare(left: PlainMutationV1, right: PlainMutationV1) {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }
  const device = left.sourceDeviceId.localeCompare(right.sourceDeviceId);
  if (device) return device;
  if (left.sourceSequence !== right.sourceSequence) {
    return left.sourceSequence - right.sourceSequence;
  }
  return left.revision.id.localeCompare(right.revision.id);
}

export function mergeToolsWorkspaceMutations(
  current: PlainMutationV1,
  incoming: PlainMutationV1,
) {
  assertToolsWorkspaceMutationV1(current);
  assertToolsWorkspaceMutationV1(incoming);
  if (
    current.entity.type !== incoming.entity.type
    || current.entity.id !== incoming.entity.id
  ) {
    throw new Error('tools.workspace 只能合并同一实体。');
  }
  return compare(current, incoming) >= 0 ? current : incoming;
}
