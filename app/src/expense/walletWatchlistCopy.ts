import type { FundPoolCategory } from '../backend/backendClient';

export const walletWatchlistCopy = {
  empty: '今天还没有整理出观察名单……><',
  error: '观察池数据出错了！先保护钱包！(・∀・*)',
  loading: '白云小姐看名单中……(●ˇ∀ˇ●)',
  onlyObserve: '只观察',
  refresh: '刷新观察池><',
  stale: '这批数据有点旧啦，只能看看不能完全当参考哦(｡･ω･｡)ﾉ♡',
  title: '今日观察池',
};

export const walletWatchlistGroupTitles: Record<FundPoolCategory, string> = {
  broad_index: '宽基观察',
  cash_parking: '现金停泊',
  stable: '稳健观察',
  watchlist: '主题/ETF 观察',
};

export function buildWatchlistReason({
  isHot,
  observeOnly,
  score,
}: {
  isHot: boolean;
  observeOnly: boolean;
  score: number | null;
}) {
  if (observeOnly) return '我先把它记下来。o(*￣▽￣*)ブ';
  if (isHot) return '它最近跑得很亮，但我会先看看是不是短期冲太急φ(゜▽゜*)♪';
  if (score !== null && score >= 70) return '规则分还不错，适合继续观察。^^';
  return '资料先放在小本本里，等后面更多字段一起判断^^。';
}
