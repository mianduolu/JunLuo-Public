const UNSUPPORTED_SHARED_HISTORY_PATTERNS = [
  /小仓鼠.{0,12}(上次|之前|以前|曾经|那次|过去).{0,28}(画|写|做|说|提|告诉|送|给|聊|看|去|喜欢|答应|约定)/,
  /(上次|之前|以前|曾经|那次|过去).{0,20}小仓鼠.{0,28}(画|写|做|说|提|告诉|送|给|聊|看|去|喜欢|答应|约定)/,
  /(我|白云小姐).{0,12}(还记得|记得|想起).{0,20}小仓鼠.{0,28}(上次|之前|以前|曾经|那次)/,
  /(我们|我和小仓鼠).{0,16}(上次|之前|以前|曾经|那次|一起).{0,28}(画|写|做|说|聊|看|去|完成|约定)/,
  /小仓鼠.{0,12}(又|还是像).{0,20}(上次|以前|之前|那次)/,
];

export function hasUnsupportedSharedHistoryClaim(value?: string) {
  if (!value?.trim()) return false;
  const compact = value.replace(/\s+/g, '');
  return UNSUPPORTED_SHARED_HISTORY_PATTERNS.some((pattern) => pattern.test(compact));
}
