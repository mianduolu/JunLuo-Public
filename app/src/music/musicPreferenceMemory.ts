import { filterCurrentMemories, getMemoryDatabase, loadMemories, type MemoryEntry } from '../memory/memoryStore';
import { createMemoryMaterialPreparation, type MemoryMaterialPreparation } from '../memory/memoryCurrentMaterials';

const MUSIC_PREFERENCE_PATTERN =
  /音乐|歌曲|点歌|纯音乐|器乐|钢琴|古典|爵士|摇滚|民谣|电子|流行|说唱|歌手|乐队|曲风|歌词|旋律|节奏|专辑|原声带|ost/i;
const EXPLICIT_PREFERENCE_PATTERN =
  /喜欢|偏爱|更爱|爱听|常听|只听|想听|不喜欢|不爱|讨厌|不要|别放|接受不了|听不惯/i;
const INSTRUMENTAL_MARKER_PATTERN =
  /纯音乐|器乐|钢琴曲|钢琴独奏|轻音乐|无歌词|没歌词|不带歌词|instrumental|piano|lofi/i;
const DISLIKE_INSTRUMENTAL_PATTERN =
  /(?:不喜欢|不爱|讨厌|不要|别放|听不惯|接受不了).{0,18}(?:纯音乐|器乐|钢琴曲|钢琴独奏|轻音乐|无歌词|没歌词|不带歌词|instrumental)|(?:纯音乐|器乐|钢琴曲|钢琴独奏|轻音乐|无歌词|没歌词|不带歌词|instrumental).{0,18}(?:不喜欢|不爱|讨厌|不要|听不惯|接受不了)/i;
const LIKE_INSTRUMENTAL_PATTERN =
  /(?:喜欢|偏爱|更爱|爱听|常听|只听|想听|更喜欢|比较喜欢|更想听).{0,18}(?:纯音乐|器乐|钢琴曲|钢琴独奏|轻音乐|无歌词|没歌词|不带歌词|instrumental)|(?:纯音乐|器乐|钢琴曲|钢琴独奏|轻音乐|无歌词|没歌词|不带歌词|instrumental).{0,18}(?:喜欢|偏爱|更爱|爱听|常听|想听)|(?:不喜欢|不爱|讨厌|不要|别放|听不惯|接受不了).{0,18}(?:歌词|带歌词|人声|唱歌)/i;

export function isExplicitMusicPreferenceStatement(content: string) {
  const normalized = content.replace(/\s+/g, '');
  return MUSIC_PREFERENCE_PATTERN.test(normalized) && EXPLICIT_PREFERENCE_PATTERN.test(normalized);
}

export function prefersInstrumentalMusicPreferenceContext(context: string) {
  if (!context.trim()) return false;
  if (DISLIKE_INSTRUMENTAL_PATTERN.test(context)) return false;
  return LIKE_INSTRUMENTAL_PATTERN.test(context);
}

export function applyMusicPreferenceToKeyword(keyword: string, preferenceContext: string) {
  const normalized = keyword.trim();
  if (!normalized || !prefersInstrumentalMusicPreferenceContext(preferenceContext)) return normalized;
  if (INSTRUMENTAL_MARKER_PATTERN.test(normalized)) return normalized;
  return `${normalized} 纯音乐`;
}

function isMusicMaterial(memory: MemoryEntry) {
  return MUSIC_PREFERENCE_PATTERN.test(
    [memory.title, memory.content, ...memory.tags, ...memory.recallCues].join(' '),
  );
}

function sortMusicMaterials(left: MemoryEntry, right: MemoryEntry) {
  return Number(right.pinned || right.protected) - Number(left.pinned || left.protected)
    || right.importance - left.importance
    || right.updatedAt - left.updatedAt;
}

function formatMusicPreferenceMemoryContext(relevant: readonly MemoryEntry[]) {
  if (!relevant.length) return '';
  const preferenceLines = relevant
    .map((memory) => `- ${memory.content}`)
    .join('\n');
  const policy = prefersInstrumentalMusicPreferenceContext(preferenceLines)
    ? '\n\n【点歌偏好执行规则】小仓鼠明确更喜欢纯音乐/器乐/无歌词音乐。点歌时这是硬约束：默认选择纯音乐、钢琴曲、器乐版、lofi 或无歌词版本；除非她本轮明确要求带歌词/某位歌手的原唱，否则不要点带歌词或明显有人声演唱的歌曲。'
    : '';
  return `【小仓鼠已确认的音乐偏好】\n${preferenceLines}${policy}`;
}

export async function prepareMusicPreferenceMemoryContext(
  preparation: MemoryMaterialPreparation = createMemoryMaterialPreparation(),
  initialCandidates?: Promise<MemoryEntry[]>,
) {
  const candidates = (await (initialCandidates ?? loadMemories())).filter(isMusicMaterial);
  let selected = (await filterCurrentMemories(await getMemoryDatabase(), candidates)).sort(sortMusicMaterials).slice(0, 6);
  const prepared = {
    context: '',
    get selectedMemories(): readonly MemoryEntry[] { return [...selected]; },
    render() {
      selected = selected.flatMap(old => {
        const memory = preparation.memoryFor(old.id);
        return memory && memory.type !== 'archived' && isMusicMaterial(memory) ? [memory] : [];
      }).sort(sortMusicMaterials);
      prepared.context = formatMusicPreferenceMemoryContext(selected);
      return prepared.context;
    },
    async refresh() {
      // Only reread the selected cards. A card leaving music can still belong to another chat section.
      selected = (await preparation.refresh(selected, memory => memory.type !== 'archived'))
        .filter(isMusicMaterial).sort(sortMusicMaterials);
      return prepared.render();
    },
  };
  await prepared.refresh();
  return prepared;
}

export async function buildMusicPreferenceMemoryContext() {
  return (await prepareMusicPreferenceMemoryContext()).context;
}
