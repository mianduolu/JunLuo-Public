import {
  classifyWalletChatIntent,
  type WalletChatIntent,
} from '../expense/walletChatPipeline';
type RoutedWalletIntent = Exclude<WalletChatIntent, 'none'>;

export type ChatSendIntentSnapshot = {
  isExpenseIntent: boolean;
  walletIntent: WalletChatIntent;
};

export type ChatSendRoute =
  | { intent: RoutedWalletIntent; kind: 'wallet' }
  | { kind: 'ordinary_reply' };

// 日程意图不再由聊天词表裁决；手动卡片操作由日程控制器接收。
export function buildChatSendIntentSnapshot(
  text: string,
): ChatSendIntentSnapshot {
  // Ordinary bookkeeping is understood by the existing chat model, never a word list.
  const isExpenseIntent = false;
  const walletIntent = classifyWalletChatIntent(text);

  return {
    isExpenseIntent,
    walletIntent,
  };
}

export function requiresConfiguredChatModelForSend(
  snapshot: ChatSendIntentSnapshot,
) {
  return (
    snapshot.walletIntent === 'none'
  );
}

export function selectChatSendRoute(
  snapshot: ChatSendIntentSnapshot,
): ChatSendRoute {
  if (snapshot.walletIntent !== 'none') {
    return { intent: snapshot.walletIntent, kind: 'wallet' };
  }
  return { kind: 'ordinary_reply' };
}
