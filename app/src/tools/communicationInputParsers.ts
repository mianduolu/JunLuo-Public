export type CommunicationIntentRoute = {
  candidateTools: string[];
  reason: string;
  unsupported?: boolean;
};

const DIRECT_SOCIAL_UNSUPPORTED_PATTERN = /小红书|点赞|点个赞|评论|收藏|关注|发布|发帖|自动发布|自动发送|静默发送|直接发送|直接发出去|直接拨出|直接打出去/;
const SMS_DRAFT_PATTERN = /短信草稿|写(?:一?条)?短信|准备(?:一?条)?短信/;
const SMS_COMPOSER_PATTERN = /(?:打开)?短信(?:编辑页|界面|App|app)?|发短信|短信发给|给.+短信/;
const PHONE_DIALER_PATTERN = /拨号|拨打电话|打电话|给.+打电话|打给/;
const SHARE_FILE_PATTERN = /分享(?:这个|一下)?.*(?:file-[a-zA-Z0-9-]+|cacheId|文件)/i;
const SHARE_TEXT_PATTERN = /分享(?:这段|一下)?(?:文字|文本|这句话|内容)|把(?:这段|这些|这句)?.*(?:分享|发给别人)/;
const SOCIAL_DRAFT_PATTERN = /君落草稿箱|社交草稿|短帖草稿|写(?:一?篇|一?条)?(?:短帖|帖子|公开表达)草稿|放进草稿箱/;

const PHONE_PATTERN = /\+?\d[\d\s().-]{4,24}\d/;

function stripQuotes(text: string) {
  return text.replace(/^[“"']|[”"']$/g, '').trim();
}

function afterColon(text: string) {
  return /[:：]\s*([\s\S]+)$/.exec(text)?.[1]?.trim();
}

function removeLeadingCommand(text: string) {
  return text
    .replace(/^(帮我|请|麻烦)?\s*(写|准备|生成|打开|分享|发|拨打|打|保存|放进|存到|创建)?\s*/g, '')
    .replace(/(短信草稿|短信|文字|文本|这段话|这句话|君落草稿箱|社交草稿|短帖草稿|公开表达草稿|分享面板|拨号页|电话)/g, ' ')
    .replace(/给\s*\+?\d[\d\s().-]{4,24}\d/g, ' ')
    .trim();
}

export function routeCommunicationIntent(text: string): CommunicationIntentRoute | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (DIRECT_SOCIAL_UNSUPPORTED_PATTERN.test(trimmed) && !/短信|拨号|电话|草稿/.test(trimmed)) {
    return { candidateTools: [], reason: 'communication_unsupported_social_action', unsupported: true };
  }
  if (SMS_DRAFT_PATTERN.test(trimmed) && !/打开|发短信/.test(trimmed)) {
    return { candidateTools: ['communication.draft_sms'], reason: 'communication_draft_sms' };
  }
  if (SMS_COMPOSER_PATTERN.test(trimmed)) {
    return { candidateTools: ['communication.open_sms_composer'], reason: 'communication_open_sms_composer' };
  }
  if (PHONE_DIALER_PATTERN.test(trimmed)) {
    return { candidateTools: ['communication.open_phone_dialer'], reason: 'communication_open_phone_dialer' };
  }
  if (SHARE_FILE_PATTERN.test(trimmed)) {
    return { candidateTools: ['communication.share_file'], reason: 'communication_share_file' };
  }
  if (SHARE_TEXT_PATTERN.test(trimmed)) {
    return { candidateTools: ['communication.share_text'], reason: 'communication_share_text' };
  }
  if (SOCIAL_DRAFT_PATTERN.test(trimmed)) {
    return { candidateTools: ['communication.draft_social_post'], reason: 'communication_draft_social_post' };
  }
  return null;
}

export function parsePhoneNumberFromText(text: string) {
  return PHONE_PATTERN.exec(text)?.[0]?.trim();
}

export function parseCommunicationInputFromText(toolId: string, text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const phoneNumber = parsePhoneNumberFromText(trimmed);
  const colonBody = afterColon(trimmed);
  if (toolId === 'communication.draft_sms') {
    const body = colonBody || removeLeadingCommand(trimmed);
    return body ? { ...(phoneNumber ? { phoneNumber } : {}), body } : null;
  }
  if (toolId === 'communication.open_sms_composer') {
    const body = colonBody || removeLeadingCommand(trimmed);
    if (!phoneNumber || !body) return null;
    return { phoneNumber, body };
  }
  if (toolId === 'communication.open_phone_dialer') {
    return phoneNumber ? { phoneNumber } : null;
  }
  if (toolId === 'communication.share_file') {
    const cacheId = /file-[a-zA-Z0-9-]+/.exec(trimmed)?.[0] || /cacheId[:：]?\s*([A-Za-z0-9._-]+)/i.exec(trimmed)?.[1];
    return cacheId ? { cacheId } : null;
  }
  if (toolId === 'communication.share_text') {
    const textToShare = colonBody || removeLeadingCommand(trimmed);
    return textToShare ? { text: stripQuotes(textToShare) } : null;
  }
  if (toolId === 'communication.draft_social_post') {
    const title = /(?:标题|题目)[:：]\s*([^，。！？\n]{1,40})/.exec(trimmed)?.[1]?.trim();
    const content = colonBody || removeLeadingCommand(trimmed);
    return content ? { ...(title ? { title } : {}), content: stripQuotes(content) } : null;
  }
  return {};
}
