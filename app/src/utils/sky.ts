import appearance from '../../assets/appearance/home-and-chat.json';

export type SkyPeriod =
  | 'midnight'
  | 'dawn'
  | 'morning'
  | 'noon'
  | 'afternoon'
  | 'evening'
  | 'night';

export type SkyTheme = {
  key: SkyPeriod;
  label: string;
  colors: readonly [string, string, ...string[]];
};

type PeriodWindow = {
  key: SkyPeriod;
  startMinute: number;
  endMinute: number;
};

const transitionMinutes = appearance.sky.transitionMinutes;

export const skyThemes = Object.fromEntries(
  Object.entries(appearance.sky.themes).map(([key, theme]): [SkyPeriod, SkyTheme] => [
    key as SkyPeriod,
    { ...theme, key: key as SkyPeriod, colors: [theme.colors[0], theme.colors[1], ...theme.colors.slice(2)] },
  ]),
) as Record<SkyPeriod, SkyTheme>;

const periodWindows = appearance.sky.windows as PeriodWindow[];

export function getSkyPeriod(date = new Date()): SkyPeriod {
  return getPeriodWindow(date).key;
}

export function getCurrentSkyTheme(date = new Date()): SkyTheme {
  const currentWindow = getPeriodWindowWithIndex(date);
  const currentTheme = skyThemes[currentWindow.key];
  const currentMinute = getMinuteOfDay(date);
  const minutesToEnd = currentWindow.endMinute - currentMinute;

  if (minutesToEnd > transitionMinutes || minutesToEnd < 0) {
    return currentTheme;
  }

  const nextWindow = periodWindows[(currentWindow.index + 1) % periodWindows.length];
  const nextTheme = skyThemes[nextWindow.key];
  const progress = 1 - minutesToEnd / transitionMinutes;

  return {
    key: currentTheme.key,
    label: currentTheme.label,
    colors: blendPalettes(currentTheme.colors, nextTheme.colors, progress),
  };
}

function getMinuteOfDay(date: Date) {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

function getPeriodWindow(date: Date) {
  return getPeriodWindowWithIndex(date).window;
}

function getPeriodWindowWithIndex(date: Date) {
  const minute = getMinuteOfDay(date);
  const index = periodWindows.findIndex((period) => minute >= period.startMinute && minute < period.endMinute);
  const resolvedIndex = index >= 0 ? index : 0;
  return { index: resolvedIndex, window: periodWindows[resolvedIndex], ...periodWindows[resolvedIndex] };
}

function blendPalettes(
  fromColors: readonly [string, string, ...string[]],
  toColors: readonly [string, string, ...string[]],
  progress: number,
): [string, string, ...string[]] {
  const count = Math.max(fromColors.length, toColors.length);
  const fromPalette = normalizePalette(fromColors, count);
  const toPalette = normalizePalette(toColors, count);
  const colors = fromPalette.map((color, index) => blendHex(color, toPalette[index], progress));

  return colors as [string, string, ...string[]];
}

function normalizePalette(colors: readonly string[], count: number) {
  return Array.from({ length: count }, (_, index) => colors[Math.min(index, colors.length - 1)]);
}

function blendHex(fromHex: string, toHex: string, progress: number) {
  const from = hexToRgb(fromHex);
  const to = hexToRgb(toHex);

  return rgbToHex({
    r: blendChannel(from.r, to.r, progress),
    g: blendChannel(from.g, to.g, progress),
    b: blendChannel(from.b, to.b, progress),
  });
}

function hexToRgb(hex: string) {
  const value = hex.replace('#', '');

  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }: { r: number; g: number; b: number }) {
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function toHex(value: number) {
  return value.toString(16).padStart(2, '0').toUpperCase();
}

function blendChannel(from: number, to: number, progress: number) {
  return Math.round(from + (to - from) * progress);
}
