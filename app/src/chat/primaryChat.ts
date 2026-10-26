export const PRIMARY_CHAT_SESSION_ID = 'chat-main-v1';

export function assertPrimaryChatSessionId(sessionId: string) {
  if (sessionId !== PRIMARY_CHAT_SESSION_ID) {
    throw new Error('检测到旧聊天，需先完成已批准的旧聊天清理。');
  }
}

/** Used before any restore write; old chat storage must not re-enter the current world. */
export function assertPrimaryChatBackupStorage(storage: Readonly<Record<string, string>>) {
  const raw = storage['junluo.chat.sessions'];
  if (raw !== undefined) {
    const sessions: unknown = JSON.parse(raw);
    if (!Array.isArray(sessions) || sessions.length !== 1
      || !sessions[0] || sessions[0].id !== PRIMARY_CHAT_SESSION_ID) {
      throw new Error('备份包含旧聊天或损坏的聊天索引，不能还原到单一主聊天。');
    }
  }
  const active = storage['junluo.chat.activeSessionId'];
  if ((raw === undefined) !== (active === undefined)) throw new Error('备份的主聊天与当前聊天标识不完整，已经停止还原。');
  if (active !== undefined) assertPrimaryChatSessionId(active);
  for (const key of Object.keys(storage)) {
    if (key === 'junluo.chat.primaryMessages' || key === 'junluo.chat.memoryOrganizedThrough') {
      throw new Error('备份包含旧聊天，不能还原到单一主聊天。');
    }
    for (const prefix of ['junluo.chat.sessionMessage.', 'junluo.chat.sessionMessageOrder.', 'junluo.chat.sessionMessages.']) {
      if (!key.startsWith(prefix)) continue;
      const encoded = key.slice(prefix.length).split('.')[0];
      assertPrimaryChatSessionId(decodeURIComponent(encoded));
      if (raw === undefined) throw new Error('备份的聊天消息缺少主聊天索引，已经停止还原。');
    }
  }
}
