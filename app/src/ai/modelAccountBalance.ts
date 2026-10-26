import type { AiConnection } from './types';

type BalanceConnection = Pick<AiConnection, 'baseUrl'>;
export type ModelAccountBalance = {
  balances: Array<{ currency: 'CNY' | 'USD'; totalBalance: string }>;
  queriedAt: number;
};

export function getModelBalanceProvider(connection: BalanceConnection): 'deepseek' | 'siliconflow' | null {
  try {
    const url = new URL(connection.baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
      || !['/', '/v1', '/v1/'].includes(url.pathname)) return null;
    if (url.hostname === 'api.deepseek.com') return 'deepseek';
    if (url.hostname === 'api.siliconflow.cn') return 'siliconflow';
  } catch { /* An invalid/custom connection is not an official account endpoint. */ }
  return null;
}

// Official schema: https://api-docs.deepseek.com/api/get-user-balance/
// Keep decimal strings exactly; currencies are separate, never summed or rounded.
export function parseDeepSeekBalance(payload: unknown): ModelAccountBalance['balances'] {
  const entries = (payload as { balance_infos?: unknown } | null)?.balance_infos;
  if (!Array.isArray(entries) || !entries.length) throw new Error('余额资料不完整。');
  const currencies = new Set<string>();
  return entries.map(entry => {
    const currency = entry?.currency;
    const totalBalance = entry?.total_balance;
    if ((currency !== 'CNY' && currency !== 'USD') || currencies.has(currency)
      || typeof totalBalance !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(totalBalance)) {
      throw new Error('余额资料不完整。');
    }
    currencies.add(currency);
    return { currency, totalBalance };
  });
}

export async function queryDeepSeekBalance(
  connection: BalanceConnection,
  apiKey: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ModelAccountBalance> {
  if (getModelBalanceProvider(connection) !== 'deepseek') throw new Error('请使用已保存的 DeepSeek 官方连接。');
  if (!apiKey.trim()) throw new Error('此连接尚未保存密钥。');
  if (options.signal?.aborted) throw new Error('余额查询已取消。');

  const controller = new AbortController();
  let timedOut = false;
  let rejectInterrupted: (error: Error) => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
  const cancel = () => {
    controller.abort();
    rejectInterrupted(new Error(timedOut ? '余额查询超时。' : '余额查询已取消。'));
  };
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; cancel(); }, options.timeoutMs ?? 15000);
  const query = async () => {
    let response: Response;
    try {
      response = await fetch('https://api.deepseek.com/user/balance', {
        method: 'GET', headers: { Authorization: `Bearer ${apiKey.trim()}` },
        signal: controller.signal, redirect: 'error', credentials: 'omit',
      });
    } catch {
      throw new Error(controller.signal.aborted
        ? (timedOut ? '余额查询超时。' : '余额查询已取消。') : '余额查询未完成：网络连接失败。');
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('余额查询未获授权，请检查此连接的密钥。');
      if (response.status === 429) throw new Error('余额查询过于频繁，请稍后手动重试。');
      throw new Error('这次没有取得余额资料。');
    }
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new Error('这次没有取得有效的余额资料。'); }
    if (controller.signal.aborted) throw new Error(timedOut ? '余额查询超时。' : '余额查询已取消。');
    return { balances: parseDeepSeekBalance(payload), queriedAt: Date.now() };
  };
  try { return await Promise.race([query(), interrupted]); }
  finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}
