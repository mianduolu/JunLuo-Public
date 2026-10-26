export type WalletOpenRequest = {
  decisionId?: string;
  fundCode?: string;
  fundName?: string;
  source?: 'chat' | 'expense';
  tab: 'wallet';
};

let walletOpenRequest: WalletOpenRequest | null = null;
const walletChatNotices: string[] = [];

export function requestOpenWalletTab(request: Partial<WalletOpenRequest> = {}) {
  walletOpenRequest = {
    ...request,
    tab: 'wallet',
  };
}

export function consumeWalletTabRequest() {
  const requested = walletOpenRequest;
  walletOpenRequest = null;
  return requested;
}

export function enqueueWalletChatNotice(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return;
  walletChatNotices.push(trimmed);
}

export function consumeWalletChatNotices() {
  const notices = walletChatNotices.splice(0);
  return notices;
}
