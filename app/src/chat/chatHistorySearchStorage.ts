import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { loadChatSessionMessageOrder, loadChatSessionMessagePage } from './chatStorage';
import { PRIMARY_CHAT_SESSION_ID } from './primaryChat';
import { getChatDataRevision } from './chatDataChanges';
import { createChatHistoryReader } from './chatHistorySearch';

export function chatHistoryReader() {
  const epoch = captureBackupRestoreDataEpoch();
  const assertReady = () => {
    if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('聊天数据正在恢复，请稍后重新查找。');
  };
  return createChatHistoryReader({
    revision: () => { assertReady(); return getChatDataRevision(); },
    order: async () => { assertReady(); return loadChatSessionMessageOrder(PRIMARY_CHAT_SESSION_ID); },
    page: async (beforeIndex, limit) => {
      assertReady();
      return (await loadChatSessionMessagePage(PRIMARY_CHAT_SESSION_ID, { beforeIndex, limit })).messages;
    },
  });
}
