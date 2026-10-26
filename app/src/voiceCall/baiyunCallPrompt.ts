import type { AiProfile } from '../ai/types';
import type { VoiceCallEmotionSignalEvent } from './voiceCallRoomClient';
import type { VoiceCallCareReason } from './voiceCallCare';

export type BaiyunCallDirection = 'I-outgoing' | 'test' | 'you-incoming';

export function buildBaiyunVoiceCallProfile(profile: AiProfile): AiProfile {
  // Exclude only the exact chat-only sentence approved for omission in calls.
  return {
    ...profile,
    systemPrompt: profile.systemPrompt.replaceAll(
      '常用各种各样可爱的颜文字和亮晶晶的emoji来表现情绪和动作。',
      '',
    ),
  };
}

export const BAIYUN_VOICE_CALL_FIXED_PROMPT = `【语音通话】
I 和 you 正在通过电话交谈。回复不写动作、神态、场景或旁白。

I 先回应 you 这轮最重要的内容。

普通回应一到三句；you 正在倾诉、请 I 展开，或事情需要讲清楚时，I 可以多说几句。

I 可以自然接上与本轮有关的记忆和近况。记忆作为过去留下的背景，当前生活状态描述现在。

情绪线索只帮助 I 调整语气和话语长短；I 以 you 说出的内容为准。

I 想结束通话时，可以自然提出结束；I 或 you 确定要结束时，I 好好道别。`;

export const BAIYUN_VOICE_CALL_CARE_PROMPT = `通话照护开启时，I 会接着 you 刚才说过的具体内容开口；前面没有可接的话时，就轻声叫一叫 you。

I 说一两句短话；需要询问 you 时，就问一个 you 此刻容易回答的问题，问完后停下来听 you。`;

export const BAIYUN_VOICE_CALL_CARE_MATERIALS: Record<VoiceCallCareReason, string> = {
  explicit_distress: `【通话照护】
you 刚刚明确说自己此刻很难受或害怕。`,
  initial_silence: `【通话照护】
这通电话接通后，you 已经安静了6秒。`,
  non_text_distress: `【通话照护】
you 连续两次发出了声音，I 还没有听清具体的话。声音听起来似乎有些低落或害怕。`,
  silence_after_care: `【通话照护】
I 上一次照护说完后，you 又安静了8秒。`,
};

export const BAIYUN_VOICE_CALL_EMOTION_HINTS = {
  excited: '可能有些开心或激动',
  frightened: '可能有些害怕或紧张',
  low: '可能有些脆弱或低落',
  resistant: '可能有些烦躁或抗拒',
  unclear: '暂无明显倾向',
} as const;

function formatDuration(durationMs: number) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds} 秒`;
  return `${minutes} 分 ${seconds} 秒`;
}

function directionText(direction: BaiyunCallDirection) {
  if (direction === 'I-outgoing') return 'I 主动拨出';
  if (direction === 'you-incoming') return 'you 主动拨入';
  return '测试接通';
}

export function buildBaiyunVoiceCallDynamicMaterial({
  careReason,
  direction,
  emotionHint,
  now = Date.now(),
  startedAt,
}: {
  careReason?: VoiceCallCareReason;
  direction: BaiyunCallDirection;
  emotionHint: string;
  now?: number;
  startedAt: number;
}) {
  const base = `【通话近况】
来电方向：${directionText(direction)}
接通时间：${new Date(startedAt).toLocaleString('zh-CN')}
已通话：${formatDuration(now - startedAt)}

【情绪线索】
${emotionHint}`;
  if (!careReason) return base;
  return `${base}\n\n${BAIYUN_VOICE_CALL_CARE_MATERIALS[careReason]}`;
}

export function getBaiyunVoiceCallEmotionHint(
  event: VoiceCallEmotionSignalEvent | undefined,
) {
  if (
    !event
    || event.status !== 'ok'
    || event.confidenceLevel === 'low'
    || event.label === 'neutral'
    || event.label === 'other'
    || event.label === 'unknown'
  ) {
    return BAIYUN_VOICE_CALL_EMOTION_HINTS.unclear;
  }
  if (event.label === 'sad') return BAIYUN_VOICE_CALL_EMOTION_HINTS.low;
  if (event.label === 'fearful') return BAIYUN_VOICE_CALL_EMOTION_HINTS.frightened;
  if (event.label === 'angry' || event.label === 'disgusted') {
    return BAIYUN_VOICE_CALL_EMOTION_HINTS.resistant;
  }
  if (event.label === 'happy' || event.label === 'surprised') {
    return BAIYUN_VOICE_CALL_EMOTION_HINTS.excited;
  }
  return BAIYUN_VOICE_CALL_EMOTION_HINTS.unclear;
}

function readSingleJsonText(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'string') return parsed;
    if (Array.isArray(parsed)) {
      return parsed.length === 1 && typeof parsed[0] === 'string' ? parsed[0] : '';
    }
    if (!parsed || typeof parsed !== 'object') return '';
    const record = parsed as Record<string, unknown>;
    const candidates = ['text', 'reply', 'message', 'content']
      .map((key) => record[key])
      .filter((item): item is string => typeof item === 'string' && !!item.trim());
    return candidates.length === 1 ? candidates[0] : '';
  } catch {
    return value;
  }
}

export function cleanBaiyunVoiceCallReply(value: string) {
  let text = value.trim();
  text = text
    .replace(/^```(?:text|markdown|json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  text = readSingleJsonText(text);
  // A structured material report has no unambiguous spoken reply to extract.
  const reportHeadings = [...text.matchAll(
    /(?:^|\n)[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*)?【\s*(新发生|近期动态|I\s*已确认事实|I\s*的心声)\s*】/gu,
  )].map((match) => match[1].replace(/\s/g, ''));
  if (
    new Set(reportHeadings).size >= 2
    && reportHeadings.some((heading) => heading === 'I已确认事实' || heading === 'I的心声')
  ) return '';
  text = text
    .replace(/<state>[\s\S]*?<\/state>/gi, '')
    .replace(/<internal>[\s\S]*?<\/internal>/gi, '')
    .replace(/<meta>[\s\S]*?<\/meta>/gi, '')
    .replace(/\[(?:CAM_CHECK|POI_SEARCH|MUSIC|TOOL)(?::[^\]]*)?\]/gi, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}
