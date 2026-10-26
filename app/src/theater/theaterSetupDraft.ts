import { emptyTheaterStorySettings, type TheaterStory, type TheaterStorySettings } from './theaterStoryTypes';

export type TheaterSetupDraft = {
  title: string;
  world: string;
  youIdentity: string;
  iIdentity: string;
  tone: string;
  openingPrompt: string;
  youName: string;
  iName: string;
  temperature: string;
  contextLimit: string;
  summaryInterval: string;
};

export type TheaterSetupErrors = Partial<Record<'temperature' | 'contextLimit' | 'summaryInterval', string>>;

export function emptyTheaterSetupDraft(): TheaterSetupDraft {
  const settings = emptyTheaterStorySettings();
  return {
    title: '', world: '', youIdentity: '', iIdentity: '', tone: '', openingPrompt: '',
    youName: settings.names.you, iName: settings.names.I,
    temperature: String(settings.temperature), contextLimit: String(settings.contextLimit), summaryInterval: '20',
  };
}

export function theaterSetupDraftFromStory(story: TheaterStory): TheaterSetupDraft {
  const settings = story.settings;
  return {
    title: story.title, world: settings.world, youIdentity: settings.youIdentity,
    iIdentity: settings.iIdentity, tone: settings.tone, openingPrompt: settings.openingPrompt,
    youName: settings.names.you, iName: settings.names.I,
    temperature: String(settings.temperature), contextLimit: String(settings.contextLimit),
    summaryInterval: String(story.summaryInterval ?? 0),
  };
}

export function copyTheaterSetupDraft(story: TheaterStory): TheaterSetupDraft {
  return { ...theaterSetupDraftFromStory(story), title: '' };
}

function readNumber(text: string) {
  return text.trim() ? Number(text) : Number.NaN;
}

export function validateTheaterSetupDraft(draft: TheaterSetupDraft): TheaterSetupErrors {
  const errors: TheaterSetupErrors = {};
  const temperature = readNumber(draft.temperature);
  const contextLimit = readNumber(draft.contextLimit);
  const summaryInterval = readNumber(draft.summaryInterval);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    errors.temperature = '请填写 0—2 之间的数字。';
  }
  if (!Number.isInteger(contextLimit) || contextLimit < 4 || contextLimit > 80) {
    errors.contextLimit = '请填写 4—80 之间的整数。';
  }
  if (!Number.isInteger(summaryInterval) || (summaryInterval !== 0 && (summaryInterval < 3 || summaryInterval > 200))) {
    errors.summaryInterval = '请填写 3—200 之间的整数，或填 0 关闭按条数提醒。';
  }
  return errors;
}

export function theaterSetupSettingsFromDraft(
  draft: TheaterSetupDraft,
  legacyPersona: string | null = null,
): TheaterStorySettings {
  if (Object.keys(validateTheaterSetupDraft(draft)).length) throw new Error('theater-setup-invalid-fields');
  const defaults = emptyTheaterStorySettings();
  return {
    world: draft.world.trim(), youIdentity: draft.youIdentity.trim(), iIdentity: draft.iIdentity.trim(),
    tone: draft.tone.trim(), openingPrompt: draft.openingPrompt.trim(),
    names: { I: draft.iName.trim() || defaults.names.I, you: draft.youName.trim() || defaults.names.you },
    temperature: Number(draft.temperature), contextLimit: Number(draft.contextLimit), legacyPersona,
  };
}

export function resolveTheaterTitle(title: string, world: string, now: number | Date): string {
  if (title.trim()) return title.trim();
  const cleanWorld = world.trim();
  if (cleanWorld) {
    const firstSentence = cleanWorld.match(/^[\s\S]*?(?:[。！？!?]|\.(?=\s|$)|[\r\n]|$)/)?.[0] ?? cleanWorld;
    return Array.from(firstSentence.trim()).slice(0, 24).join('');
  }
  const date = new Date(now);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `未命名小剧场 ${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function isTheaterSetupDirty(draft: TheaterSetupDraft, baseline: TheaterSetupDraft): boolean {
  const defaults = emptyTheaterStorySettings();
  const comparable = (value: TheaterSetupDraft, key: keyof TheaterSetupDraft) => {
    const text = value[key].trim();
    if (key === 'youName') return text || defaults.names.you;
    if (key === 'iName') return text || defaults.names.I;
    if (key === 'temperature' || key === 'contextLimit' || key === 'summaryInterval') {
      return text && Number.isFinite(Number(text)) ? String(Number(text)) : text;
    }
    return text;
  };
  return (Object.keys(baseline) as (keyof TheaterSetupDraft)[])
    .some((key) => comparable(draft, key) !== comparable(baseline, key));
}
