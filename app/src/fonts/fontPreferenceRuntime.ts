import type { FontChoice } from './fontCatalog';

const syncedChoiceListeners = new Set<(choice: FontChoice) => void>();

export function notifySyncedFontChoice(choice: FontChoice) {
  for (const listener of syncedChoiceListeners) listener(choice);
}

export function subscribeSyncedFontChoice(listener: (choice: FontChoice) => void) {
  syncedChoiceListeners.add(listener);
  return () => { syncedChoiceListeners.delete(listener); };
}

export type FontRuntimePresentation = {
  fontFamily?: string;
  isFontReady: boolean;
};

export function resolveFontRuntimePresentation(
  choice: FontChoice,
  xiaolaiReady: boolean,
): FontRuntimePresentation {
  if (choice === 'xiaolai' && xiaolaiReady) {
    return { fontFamily: 'Xiaolai', isFontReady: true };
  }
  return {
    fontFamily: undefined,
    isFontReady: choice === 'system',
  };
}
