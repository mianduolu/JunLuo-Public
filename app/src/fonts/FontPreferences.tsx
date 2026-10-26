import {
  appearanceFontStorageBridge as AsyncStorage,
} from '../sync/syncAppearanceFontsStorageBridge';
import { useFonts } from 'expo-font';
import { PropsWithChildren, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { beginRuntimeWorkload, type RuntimeWorkloadSpan } from '../runtime/runtimeWorkloadDiagnostics';
import { customFontSources, isFontChoice, type FontChoice } from './fontCatalog';
import { resolveFontRuntimePresentation, subscribeSyncedFontChoice } from './fontPreferenceRuntime';

const FONT_CHOICE_KEY = 'junluo.fontChoice';

type FontPreferencesValue = {
  choice: FontChoice;
  fontFamily?: string;
  isFontReady: boolean;
  setChoice: (choice: FontChoice) => void;
};

const FontPreferencesContext = createContext<FontPreferencesValue | undefined>(undefined);

type XiaolaiFontLoaderProps = {
  onReady: () => void;
};

function XiaolaiFontLoader({ onReady }: XiaolaiFontLoaderProps) {
  const fontLoadSpanRef = useRef<RuntimeWorkloadSpan | null>(null);
  const [areFontsLoaded, fontLoadError] = useFonts(customFontSources);

  useEffect(() => {
    fontLoadSpanRef.current = beginRuntimeWorkload('font.bundle_load');
    return () => {
      fontLoadSpanRef.current?.finish('cancelled');
      fontLoadSpanRef.current = null;
    };
  }, []);

  useEffect(() => {
    const span = fontLoadSpanRef.current;
    if (areFontsLoaded) span?.finish('ok');
    else if (fontLoadError) span?.finish('failed');
    else return;
    fontLoadSpanRef.current = null;
    if (areFontsLoaded) onReady();
  }, [areFontsLoaded, fontLoadError, onReady]);

  return null;
}

export function FontPreferencesProvider({ children }: PropsWithChildren) {
  const [choice, setStoredChoice] = useState<FontChoice>('system');
  const [xiaolaiReady, setXiaolaiReady] = useState(false);
  const handleXiaolaiReady = useCallback(() => setXiaolaiReady(true), []);

  useEffect(() => {
    let acceptInitialRead = true;
    const unsubscribe = subscribeSyncedFontChoice((nextChoice) => {
      acceptInitialRead = false;
      setStoredChoice(nextChoice);
    });
    AsyncStorage.getItem(FONT_CHOICE_KEY).then((storedChoice) => {
      if (acceptInitialRead && isFontChoice(storedChoice)) {
        setStoredChoice(storedChoice);
      }
    });
    return () => {
      acceptInitialRead = false;
      unsubscribe();
    };
  }, []);

  const value = useMemo<FontPreferencesValue>(() => {
    const presentation = resolveFontRuntimePresentation(choice, xiaolaiReady);

    return {
      choice,
      ...presentation,
      setChoice(nextChoice) {
        setStoredChoice(nextChoice);
        void AsyncStorage.setItem(FONT_CHOICE_KEY, nextChoice);
      },
    };
  }, [choice, xiaolaiReady]);

  return (
    <FontPreferencesContext.Provider value={value}>
      {children}
      {choice === 'xiaolai' ? <XiaolaiFontLoader onReady={handleXiaolaiReady} /> : null}
    </FontPreferencesContext.Provider>
  );
}

export function useFontPreferences() {
  const context = useContext(FontPreferencesContext);

  if (!context) {
    throw new Error('useFontPreferences must be used inside FontPreferencesProvider.');
  }

  return context;
}

// Another native display surface receives the current font; no second settings owner.
export function FontPresentationProvider({ value, children }: PropsWithChildren<{ value: FontPreferencesValue }>) {
  return <FontPreferencesContext.Provider value={value}>{children}</FontPreferencesContext.Provider>;
}
