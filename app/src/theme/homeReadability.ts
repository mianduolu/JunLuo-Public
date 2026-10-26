import type { TextStyle } from 'react-native';

import { colors } from './colors';
import type { SkyTheme } from '../utils/sky';

export type OverlayTextTone = 'dark' | 'light';

export type HomeBackgroundReadability = {
  headerText: OverlayTextTone;
  exposedLabelText: OverlayTextTone;
};

type ReadabilityOverrides = {
  headerTextTone: 'auto' | OverlayTextTone;
  exposedLabelTextTone: 'auto' | OverlayTextTone;
};

export function getSkyBackgroundReadability(theme: SkyTheme): HomeBackgroundReadability {
  return {
    headerText: getTextToneForColor(theme.colors[0]),
    exposedLabelText: getTextToneForColor(theme.colors[Math.min(1, theme.colors.length - 1)]),
  };
}

export function resolveBackgroundReadability(
  defaultReadability: HomeBackgroundReadability,
  overrides: ReadabilityOverrides,
): HomeBackgroundReadability {
  return {
    headerText: overrides.headerTextTone === 'auto' ? defaultReadability.headerText : overrides.headerTextTone,
    exposedLabelText:
      overrides.exposedLabelTextTone === 'auto'
        ? defaultReadability.exposedLabelText
        : overrides.exposedLabelTextTone,
  };
}

export function getOverlayTextStyle(tone: OverlayTextTone): TextStyle {
  const useDarkText = tone === 'dark';

  return {
    color: useDarkText ? colors.ink : '#FFFFFF',
    textShadowColor: useDarkText ? 'rgba(255,255,255,0.28)' : 'rgba(20,23,47,0.3)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  };
}

function getTextToneForColor(backgroundColor: string): OverlayTextTone {
  return getHexLuminance(backgroundColor) > 0.46 ? 'dark' : 'light';
}

function getHexLuminance(hex: string) {
  const color = hex.replace('#', '');
  const channels = [color.slice(0, 2), color.slice(2, 4), color.slice(4, 6)].map((channel) => {
    const value = parseInt(channel, 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });

  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
