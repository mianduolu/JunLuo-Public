import { extractSafeDirectPlainText, extractVisibleReplyFromRaw } from '../ai/visibleReplyExtraction';

const BRACKETED_MUSIC_COMMAND_PATTERN = /[\[［【]\s*MUSIC\s*[:：]\s*([^\]］】\r\n]+?)\s*[\]］】]/gi;
const BARE_MUSIC_COMMAND_PATTERN = /(^|\n)[ \t]*MUSIC\s*[:：]\s*([^\r\n]+?)[ \t]*(?=\r?\n|$)/gi;
const MUSIC_PLAYBACK_FACT_PATTERN =
  /(?:播放器|播放圈|进度条|音乐卡片|卡片|按钮).{0,24}(?:弹|出现|转|亮|动|播放|放)|(?:已经|真的|现在|正在|开始|成功|刚刚|这会儿).{0,16}(?:播放|放出来|放着|响起|响了|听到|听见|在听)|(?:听到|听见).{0,20}(?:钢琴|旋律|歌声|雨声|前奏|音符)|(?:钢琴|旋律|歌声|雨声|前奏|音符).{0,24}(?:响起|漫上来|飘起来|浮起来|跟着|一起|共振)|(?:我们|咱们|我(?:现在)?).{0,12}(?:一起)?(?:在听|听着|听到了|听见了)/;

export const MUSIC_CAPABILITY_INSTRUCTION = `【音乐点歌能力】
音乐点歌开启时，I 可以在普通聊天里给小仓鼠递一首歌。

适合递歌的时刻：
- 小仓鼠明确想听歌、点歌、放歌、来首歌。
- 小仓鼠确认 I 的音乐提议。
- 气氛很适合：小仓鼠想被陪、想安静下来、想转换心情、想要一点仪式感，或 I 很想把一首歌递到她手边。

放歌时，I 亲自选择一首具体歌曲。
正文自然私聊，像把歌放给小仓鼠听。
内部指令写成：
[MUSIC:准确歌曲名 准确歌手名/演奏者名]

默认递一首歌。
小仓鼠明确要歌单、多首或连放时，再递 2 到 3 首。

小仓鼠已确认的音乐偏好优先。
她偏好纯音乐、器乐、钢琴、轻音乐或无歌词时，选择具体的无歌词版本，并在指令里写清楚版本关键词。

硬边界：
[MUSIC:...] 里只能点正式歌曲或可搜索到的具体音乐版本。
音乐卡片出现前、播放成功前，I 只说正在递歌或找歌。
搜索到候选不等于已经播放。
只有播放工具或音乐卡真实播放成功后，I 才能说已经播放、正在听、声音响起。

音乐点歌指令只作为君落内部解析入口：
[MUSIC:准确歌曲名 准确歌手名]
正文自然私聊，指令不当作给小仓鼠解释的内容。`;

function splitMusicSentences(content: string) {
  const sentences: string[] = [];
  let current = '';
  for (const char of content) {
    current += char;
    if (/[。！？!?\n]/.test(char)) {
      sentences.push(current);
      current = '';
    }
  }
  if (current.trim()) sentences.push(current);
  return sentences;
}

function removeMusicPlaybackFactClaims(content: string) {
  const cleaned = splitMusicSentences(content)
    .filter((sentence) => !MUSIC_PLAYBACK_FACT_PATTERN.test(sentence))
    .join('')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[\s，,。；;、]+|[\s，,；;、]+$/g, '')
    .trim();
  return cleaned;
}

function pushUniqueMusicKeyword(keywords: string[], value?: string) {
  const keyword = value?.trim();
  if (!keyword) return;
  if (keywords.some((item) => item.toLowerCase() === keyword.toLowerCase())) return;
  keywords.push(keyword);
}

export function extractMusicCommand(contents: string[]) {
  const keywords: string[] = [];
  const cleanedContents = contents
    .map((content) => {
      const withoutBracketed = content.replace(BRACKETED_MUSIC_COMMAND_PATTERN, (_whole, captured: string) => {
        pushUniqueMusicKeyword(keywords, captured);
        return '';
      });
      return withoutBracketed.replace(
        BARE_MUSIC_COMMAND_PATTERN,
        (_whole, prefix: string, captured: string) => {
          pushUniqueMusicKeyword(keywords, captured);
          return prefix;
        },
      );
    })
    .map((content) =>
      content
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^[\s，,。；;、]+|[\s，,；;、]+$/g, '')
        .trim(),
    )
    .filter(Boolean);
  const keyword = keywords[0];
  const safeContents = cleanedContents
    .map(removeMusicPlaybackFactClaims)
    .filter(Boolean);
  const fallbackContent = keyword
    ? '哎呀，点歌界面还没放出来……T T。'
    : '唔，让我再点一次吧……T T';

  return {
    contents: safeContents.length ? safeContents : [fallbackContent],
    keyword,
    keywords,
  };
}

export function extractMusicCommandFromEnvelope(raw: string | undefined) {
  const structured = extractVisibleReplyFromRaw({ raw: raw ?? '', expectedStructure: 'single_root_json' });
  const visible = structured.status === 'visible' ? structured
    : extractSafeDirectPlainText({ raw: raw ?? '', forbiddenStandaloneTokens: [] });
  return extractMusicCommand(visible.status === 'visible' ? visible.messages : []).keywords;
}
