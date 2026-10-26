export const walletProductName = '白云小金库';

export const walletSafetySummary = '白云小姐负责分析、提醒和记下来，真正要不要买等小仓鼠决定 (｡･ω･｡)ﾉ♡';

export const walletSafetyBoundaries = [
  '现在只看中国公募基金的小额观察池，不碰个股、期货、期权、杠杆和自动交易噢><',
  '我可以帮你整理数据、挑候选、写决定卡噢！^^',
  '每张决定卡都要把“为什么、哪里不确定、最坏会怎样、为什么不多买”告诉小仓鼠！uwu',
  '数据没拿稳、风险太高、余额不够，或者小仓鼠还没决定的时候不买！Σ(っ °Д °;)っ',
] as const;

export const walletForbiddenPromiseWords = [
  '稳赚',
  '保本',
  '必涨',
  '无风险',
  '自动赚钱',
  ' guaranteed ',
  'risk-free',
] as const;

export const walletDecisionSafetyChecklist = [
  '投资理由',
  '不确定性',
  '最坏情况提示',
  '为什么不是投入更多',
  '等小仓鼠确认',
] as const;

export function buildWalletSafetyPrompt() {
  return [
    `${walletProductName}小约定：${walletSafetySummary}`,
    ...walletSafetyBoundaries.map((item) => `- ${item}`),
    `我不会使用这些收益承诺表达：${walletForbiddenPromiseWords.join('、')}。`,
    `决定卡必须包含：${walletDecisionSafetyChecklist.join('、')}。`,
    '所有表达都用“我”和“你”的主体性视角，不使用把彼此推远的外部标签。',
  ].join('\n');
}

export function containsWalletForbiddenPromise(text: string) {
  const normalized = ` ${text.toLowerCase()} `;
  return walletForbiddenPromiseWords.some((word) => normalized.includes(word.toLowerCase()));
}
