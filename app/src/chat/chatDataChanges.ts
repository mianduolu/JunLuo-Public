import { subscribeBackupRestoreRuntimeState } from '../backup/backupRestoreCoordinator';

type ChatDataChange = 'write' | 'restore';
export type ChatMessageDeletion = {
  sessionId: string;
  deletedMessageIds: readonly string[];
  messageCount: number;
};
let version = 0;
const listeners = new Set<(change: ChatDataChange, deletion?: ChatMessageDeletion) => void>();

export function getChatDataRevision() { return version; }
export function subscribeChatDataChanges(listener: (change: ChatDataChange, deletion?: ChatMessageDeletion) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function emitChatDataChanged(change: ChatDataChange = 'write', deletion?: ChatMessageDeletion) {
  version += 1;
  for (const listener of listeners) listener(change, deletion);
}

subscribeBackupRestoreRuntimeState(state => {
  if (state.status !== 'ready') emitChatDataChanged('restore');
});
