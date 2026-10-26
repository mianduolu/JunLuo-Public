import { useEffect, useState } from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { AppText as Text } from '../components/AppText';
import { findChatSessionContainingMessage, loadChatSessionMessage } from '../chat/chatStorage';
import type { NotebookEntry } from '../chat/notebookStore';
import { resolveNotebookSource } from './notebookSource';

export function NotebookSourceExcerpt({ entry, style }: { entry: NotebookEntry; style: StyleProp<TextStyle> }) {
  const [result, setResult] = useState<{ entry: NotebookEntry; content: string | null; failed?: boolean } | null>(null);
  useEffect(() => {
    let active = true;
    void resolveNotebookSource(entry, async (messageId) => {
      const sessionId = await findChatSessionContainingMessage(messageId);
      return sessionId ? loadChatSessionMessage(sessionId, messageId) : null;
    }).then(content => {
      if (active) setResult({ entry, content });
    }).catch(() => {
      if (active) setResult({ entry, content: null, failed: true });
    });
    return () => { active = false; };
  }, [entry]);

  if (!entry.sourceMessageId && !entry.sourceExcerpt) return null;
  if (result?.entry !== entry) return <Text style={style}>正在读取原消息…</Text>;
  if (result.failed) return <Text style={style}>原消息读取失败，请重新打开小本本。</Text>;
  return <Text style={style}>{result.content ? `原话：${result.content}` : '原消息已不可用'}</Text>;
}
