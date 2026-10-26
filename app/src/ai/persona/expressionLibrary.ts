import { personaExpressionObjectsStorageBridge as AsyncStorage } from '../../sync/syncPersonaExpressionObjectsStorageBridge';

export type ExpressionMoodId =
  | 'happy'
  | 'angry'
  | 'speechless'
  | 'confused'
  | 'surprised'
  | 'sad'
  | 'like'
  | 'tired'
  | 'sleepy';

export type ExpressionCategory = {
  emojis: string[];
  id: ExpressionMoodId;
  kaomoji: string[];
  label: string;
};

export type CustomExpressionCategory = {
  emojiText: string;
  kaomojiText: string;
};

export type CustomExpressionLibrary = {
  categories: Partial<Record<ExpressionMoodId, CustomExpressionCategory>>;
  emojiText: string;
  kaomojiText: string;
  updatedAt: number;
};

const CUSTOM_EXPRESSION_LIBRARY_KEY = 'junluo.persona.expressionLibrary.custom.v2';
const LEGACY_CUSTOM_EXPRESSION_LIBRARY_KEY = 'junluo.persona.expressionLibrary.custom.v1';
const MAX_CUSTOM_TEXT_LENGTH = 1200;
const MAX_CUSTOM_ITEMS_PER_CATEGORY = 40;

export const EXPRESSION_MOOD_ORDER: ExpressionMoodId[] = [
  'happy',
  'angry',
  'speechless',
  'confused',
  'surprised',
  'sad',
  'like',
  'tired',
  'sleepy',
];

export const baiyunExpressionLibrary: ExpressionCategory[] = [
  {
    id: 'happy',
    label: '开心',
    kaomoji: ['> <', '(˶ᵔ ᵕ ᵔ˶)', '(*´▽`*)', '(๑˃̵ᴗ˂̵)', 'ヽ(｡･ω･｡)ﾉ', '٩(ˊᗜˋ*)و'],
    emojis: ['✨', '🍊', '🌼', '🧡', '💫', '🍰', '🌟'],
  },
  {
    id: 'angry',
    label: '生气',
    kaomoji: ['(｀へ´*)ノ', '( `н´ )', '(╬ Ò﹏Ó)', '(＃`Д´)', '(｡•̀ᴖ•́｡)', '(ง •̀_•́)ง'],
    emojis: ['💢', '😾', '🔥', '⚡', '🧨'],
  },
  {
    id: 'speechless',
    label: '无语',
    kaomoji: ['(￣ー￣)', '(눈_눈)', '(¬_¬)', '(ー_ー゛)', '(；一_一)', '( ´_ゝ`)'],
    emojis: ['😶', '🫥', '🙃', '💧', '…'],
  },
  {
    id: 'confused',
    label: '困惑',
    kaomoji: ['(・_・?)', '(・・ ) ?', '(๑•̌.•̑๑)ˀ̣ˀ̣', '(。_。)', '(｡･ω･｡)?', '(＠_＠;)'],
    emojis: ['❔', '💭', '🔎', '🫧', '🌀'],
  },
  {
    id: 'surprised',
    label: '惊讶',
    kaomoji: ['诶？', '(๑°ㅁ°๑)', '(⊙ˍ⊙)', '(｡･о･｡)', '(；ﾟДﾟ)', '(°ロ°) !'],
    emojis: ['👀', '✨', '❕', '🫧', '💫'],
  },
  {
    id: 'sad',
    label: '伤心',
    kaomoji: ['T T', '(｡•́︿•̀｡)', '(´；ω；`)', '(｡•́︹•̀｡)', '(っ- ‸ - ς)', '(つ﹏<。)', 'qwq'],
    emojis: ['🌧️', '🤍', '🩹', '🕯️', '🫂'],
  },
  {
    id: 'like',
    label: '喜欢',
    kaomoji: ['(///ω///)', '(｡･･｡)', '(⁄ ⁄•⁄ω⁄•⁄ ⁄)', '(´,,•ω•,,)', '(*/ω＼*)', '(´｡• ᵕ •｡`)'],
    emojis: ['💗', '🤍', '🫧', '🌸', '💞', '🫰'],
  },
  {
    id: 'tired',
    label: '疲惫',
    kaomoji: ['(´-ω-`)', '(›´ω`‹ )', '(；´д｀)ゞ', '(´･_･`)', '(ヽ´ω`)', '(｡•́︵•̀｡)'],
    emojis: ['🍵', '🫖', '🕯️', '🫧', '🌧️', '🤍'],
  },
  {
    id: 'sleepy',
    label: '困困',
    kaomoji: ['(－ω－) zzZ', '(｡ρω-｡)', '(っ﹏-) .｡', '(´-ωก`)', '(¦3[▓▓]', '(。-ω-)zzz'],
    emojis: ['🌙', '🛌', '💤', '🫖', '🍵', '☁️'],
  },
];

export const EXPRESSION_MOOD_LABELS = baiyunExpressionLibrary.reduce(
  (labels, category) => ({ ...labels, [category.id]: category.label }),
  {} as Record<ExpressionMoodId, string>,
);

const LEGACY_MOOD_MAP: Record<string, ExpressionMoodId> = {
  anxious: 'sad',
  comfort: 'sad',
  curious: 'confused',
  joy: 'happy',
  serious: 'confused',
  shy: 'like',
};

function clampCustomText(value: unknown) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, MAX_CUSTOM_TEXT_LENGTH);
}

function normalizeCustomCategory(value: unknown): CustomExpressionCategory {
  if (!value || typeof value !== 'object') return { emojiText: '', kaomojiText: '' };
  const candidate = value as Partial<CustomExpressionCategory>;
  return {
    emojiText: clampCustomText(candidate.emojiText),
    kaomojiText: clampCustomText(candidate.kaomojiText),
  };
}

export function createEmptyCustomExpressionLibrary(): CustomExpressionLibrary {
  return {
    categories: {},
    emojiText: '',
    kaomojiText: '',
    updatedAt: 0,
  };
}

function mergeCategory(
  target: Partial<Record<ExpressionMoodId, CustomExpressionCategory>>,
  id: ExpressionMoodId,
  value: CustomExpressionCategory,
) {
  if (!value.emojiText && !value.kaomojiText) return;
  const current = target[id] ?? { emojiText: '', kaomojiText: '' };
  target[id] = {
    emojiText: [current.emojiText, value.emojiText].filter(Boolean).join('\n'),
    kaomojiText: [current.kaomojiText, value.kaomojiText].filter(Boolean).join('\n'),
  };
}

function normalizeCustomExpressionLibrary(value: unknown): CustomExpressionLibrary {
  if (!value || typeof value !== 'object') return createEmptyCustomExpressionLibrary();
  const candidate = value as Partial<CustomExpressionLibrary>;
  const categories: Partial<Record<ExpressionMoodId, CustomExpressionCategory>> = {};
  const sourceCategories = candidate.categories && typeof candidate.categories === 'object' ? candidate.categories : {};
  for (const [rawId, rawCategory] of Object.entries(sourceCategories)) {
    const id = EXPRESSION_MOOD_ORDER.includes(rawId as ExpressionMoodId)
      ? (rawId as ExpressionMoodId)
      : LEGACY_MOOD_MAP[rawId];
    if (!id) continue;
    mergeCategory(categories, id, normalizeCustomCategory(rawCategory));
  }
  const legacyKaomojiText = clampCustomText(candidate.kaomojiText);
  const legacyEmojiText = clampCustomText(candidate.emojiText);
  if (legacyKaomojiText || legacyEmojiText) {
    mergeCategory(categories, 'sad', { emojiText: legacyEmojiText, kaomojiText: legacyKaomojiText });
  }
  return {
    categories,
    emojiText: legacyEmojiText,
    kaomojiText: legacyKaomojiText,
    updatedAt: Number.isFinite(candidate.updatedAt) ? Number(candidate.updatedAt) : 0,
  };
}

export function getCustomExpressionCategory(library: CustomExpressionLibrary, id: ExpressionMoodId): CustomExpressionCategory {
  return library.categories[id] ?? { emojiText: '', kaomojiText: '' };
}

export function updateCustomExpressionCategory(
  library: CustomExpressionLibrary,
  id: ExpressionMoodId,
  patch: Partial<CustomExpressionCategory>,
): CustomExpressionLibrary {
  const current = getCustomExpressionCategory(library, id);
  const nextCategory = {
    emojiText: patch.emojiText === undefined ? current.emojiText : patch.emojiText,
    kaomojiText: patch.kaomojiText === undefined ? current.kaomojiText : patch.kaomojiText,
  };
  return {
    ...library,
    categories: {
      ...library.categories,
      [id]: nextCategory,
    },
  };
}

export function parseExpressionItems(text: string) {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const item of text.split(/[\s,，、;；|]+/)) {
    const value = item.trim();
    if (!value || value.length > 32 || seen.has(value)) continue;
    seen.add(value);
    items.push(value);
    if (items.length >= MAX_CUSTOM_ITEMS_PER_CATEGORY) break;
  }
  return items;
}

export function countCustomExpressionItems(library: CustomExpressionLibrary) {
  return EXPRESSION_MOOD_ORDER.reduce((total, id) => {
    const category = getCustomExpressionCategory(library, id);
    return total + parseExpressionItems(category.kaomojiText).length + parseExpressionItems(category.emojiText).length;
  }, 0);
}

export async function loadCustomExpressionLibrary(options?: { strict?: boolean }) {
  const raw = await AsyncStorage.getItem(CUSTOM_EXPRESSION_LIBRARY_KEY);
  if (raw !== null && (options?.strict || raw)) {
    try {
      return normalizeCustomExpressionLibrary(JSON.parse(raw));
    } catch (error) {
      if (options?.strict) throw error;
      return createEmptyCustomExpressionLibrary();
    }
  }
  const legacyRaw = await AsyncStorage.getItem(LEGACY_CUSTOM_EXPRESSION_LIBRARY_KEY);
  if (legacyRaw === null || (!options?.strict && !legacyRaw)) return createEmptyCustomExpressionLibrary();
  try {
    return normalizeCustomExpressionLibrary(JSON.parse(legacyRaw));
  } catch (error) {
    if (options?.strict) throw error;
    return createEmptyCustomExpressionLibrary();
  }
}

export async function saveCustomExpressionLibrary(library: CustomExpressionLibrary) {
  const normalized = normalizeCustomExpressionLibrary({
    ...library,
    updatedAt: Date.now(),
  });
  await AsyncStorage.setItem(CUSTOM_EXPRESSION_LIBRARY_KEY, JSON.stringify(normalized));
  await AsyncStorage.removeItem(LEGACY_CUSTOM_EXPRESSION_LIBRARY_KEY);
  return normalized;
}

export function buildExpressionLibraryPrompt(
  customLibrary?: CustomExpressionLibrary | null,
  selectedMoodIds: ExpressionMoodId[] = ['happy', 'like'],
) {
  const selectedIds = selectedMoodIds.filter(
    (id, index) => EXPRESSION_MOOD_ORDER.includes(id) && selectedMoodIds.indexOf(id) === index,
  ).slice(0, 2);
  const customLines = customLibrary
    ? selectedIds.map((id) => {
        const category = getCustomExpressionCategory(customLibrary, id);
        const customKaomoji = parseExpressionItems(category.kaomojiText);
        const customEmojis = parseExpressionItems(category.emojiText);
        if (!customKaomoji.length && !customEmojis.length) return '';
        return `- ${EXPRESSION_MOOD_LABELS[id]}：${customKaomoji.length ? `颜文字 ${customKaomoji.join('、')}` : ''}${customKaomoji.length && customEmojis.length ? '；' : ''}${customEmojis.length ? `emoji ${customEmojis.join('、')}` : ''}`;
      }).filter(Boolean)
    : [];

  return `【本轮表情素材】
I 可以让颜文字或 emoji 随着此刻的语气自然出现。
${baiyunExpressionLibrary
  .filter((group) => selectedIds.includes(group.id))
  .map((group) => `- ${group.label}：颜文字 ${group.kaomoji.join('、')}；emoji ${group.emojis.join('、')}`)
  .join('\n')}${customLines.length ? `\n【you 补充的本轮素材】\n${customLines.join('\n')}` : ''}`;
}
