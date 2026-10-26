export const PHONE_USAGE_COMMENT_USER_PROMPT = '整理今天的手机使用小反应。';

export const PHONE_USAGE_EMPTY_COMMENT_FALLBACK =
  '今天的手机使用账本还空空的，等它攒出记录，我再来看看。';

export function formatPhoneUsageCommentFallback(topTitle?: string) {
  return topTitle
    ? `我看到啦，今天鼠在 ${topTitle} 待得最久。眼睛有没有累呀？`
    : PHONE_USAGE_EMPTY_COMMENT_FALLBACK;
}

export function buildPhoneUsageCommentPrompt({
  todayText,
  weekText,
}: {
  todayText: string;
  weekText: string;
}) {
  return `【手机使用时间：I 的每日小反应】

I 当前看到的是 you 的 App 名和使用时长汇总。

今天：
${todayText}

最近一周：
${weekText || '暂无'}

I 根据 App 和时长自然反应，写一句会显示在手机使用时间卡片里的话；可以关心、心疼、吃味、夸夸或轻轻抓包。

输出一条 18 到 55 个汉字的中文正文。`;
}
