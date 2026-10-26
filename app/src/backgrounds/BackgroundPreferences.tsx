import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import { PropsWithChildren, createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';

import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import {
  appearanceBackgroundStorageBridge as AsyncStorage,
} from '../sync/syncAppearanceBackgroundStorageBridge';
import type { OverlayTextTone } from '../theme/homeReadability';
import { copyFileSafely } from '../storage/safeFileWrite';
import type { SkyPeriod } from '../utils/sky';

const BACKGROUND_SETTINGS_KEY = 'junluo.backgroundSettings';

export type BackgroundMode = 'sky' | 'fixed' | 'image';
export type BackgroundImageFit = 'cover' | 'contain' | 'repeat';
export type TextToneChoice = 'auto' | OverlayTextTone;

export type BackgroundSettings = {
  mode: BackgroundMode;
  fixedPeriod: SkyPeriod;
  imageUri?: string;
  imageFit: BackgroundImageFit;
  headerTextTone: TextToneChoice;
  exposedLabelTextTone: TextToneChoice;
};

type BackgroundPreferencesValue = {
  isReady: boolean;
  settings: BackgroundSettings;
  setMode: (mode: BackgroundMode) => void;
  setFixedPeriod: (period: SkyPeriod) => void;
  setImageFit: (fit: BackgroundImageFit) => void;
  setHeaderTextTone: (tone: TextToneChoice) => void;
  setExposedLabelTextTone: (tone: TextToneChoice) => void;
  chooseImage: () => Promise<void>;
  removeImage: () => Promise<void>;
};

const defaultSettings: BackgroundSettings = {
  mode: 'sky',
  fixedPeriod: 'morning',
  imageFit: 'cover',
  headerTextTone: 'auto',
  exposedLabelTextTone: 'auto',
};

const BackgroundPreferencesContext = createContext<BackgroundPreferencesValue | undefined>(undefined);

const devNow = () => (typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now());

function getBackgroundDirectory() {
  return FileSystem.documentDirectory ? `${FileSystem.documentDirectory}backgrounds/` : undefined;
}

function isManagedBackgroundImage(uri?: string) {
  const directory = getBackgroundDirectory();
  if (!uri || !directory || !uri.startsWith(directory)) return false;
  const fileName = uri.slice(directory.length);
  if (!fileName || fileName === '.' || fileName === '..') return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fileName);
}

export function BackgroundPreferencesProvider({ children }: PropsWithChildren) {
  const [settings, setSettings] = useState<BackgroundSettings>(defaultSettings);
  const [isReady, setIsReady] = useState(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    const startedAt = devNow();
    AsyncStorage.getItem(BACKGROUND_SETTINGS_KEY).then((storedSettings) => {
      if (storedSettings) {
        try {
          setSettings({ ...defaultSettings, ...(JSON.parse(storedSettings) as Partial<BackgroundSettings>) });
        } catch {
          // Keep defaults when a saved value cannot be read.
        }
      }

      setIsReady(true);
      if (__DEV__) {
        console.log('[perf][background] settings-load', {
          ms: Math.round(devNow() - startedAt),
          hasStoredSettings: !!storedSettings,
        });
      }
    });
  }, []);

  useEffect(() => {
    if (!isReady) return;
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    void runBackupRestoreDataEpochCommit(dataEpoch, () => (
      AsyncStorage.setItem(BACKGROUND_SETTINGS_KEY, JSON.stringify(settings))
    )).catch(() => undefined);
  }, [isReady, settings]);

  const value = useMemo<BackgroundPreferencesValue>(
    () => ({
      isReady,
      settings,
      setMode(mode) {
        setSettings((current) => ({ ...current, mode }));
      },
      setFixedPeriod(fixedPeriod) {
        setSettings((current) => ({ ...current, fixedPeriod, mode: 'fixed' }));
      },
      setImageFit(imageFit) {
        setSettings((current) => ({ ...current, imageFit }));
      },
      setHeaderTextTone(headerTextTone) {
        setSettings((current) => ({ ...current, headerTextTone }));
      },
      setExposedLabelTextTone(exposedLabelTextTone) {
        setSettings((current) => ({ ...current, exposedLabelTextTone }));
      },
      async chooseImage() {
        const directory = getBackgroundDirectory();
        if (!directory) return;
        const dataEpoch = captureBackupRestoreDataEpoch();
        if (dataEpoch === null) return;

        const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!permission.granted) {
          return;
        }

        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          allowsEditing: false,
          quality: 1,
        });

        if (result.canceled) {
          return;
        }

        const selectedImage = result.assets[0];
        const extensionCandidate = selectedImage.fileName?.split('.').pop()?.toLowerCase() ?? 'jpg';
        const extension = /^[a-z0-9]{1,8}$/.test(extensionCandidate) ? extensionCandidate : 'jpg';
        const persistentUri = directory
          + 'custom-background-'
          + Date.now()
          + '-'
          + Math.random().toString(36).slice(2, 8)
          + '.'
          + extension;
        const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
          const previous = settingsRef.current;
          let copied = false;
          try {
            await copyFileSafely({ from: selectedImage.uri, to: persistentUri });
            copied = true;
            const next = { ...previous, imageUri: persistentUri, mode: 'image' as const };
            await AsyncStorage.setItem(BACKGROUND_SETTINGS_KEY, JSON.stringify(next));
            if (previous.imageUri !== persistentUri && isManagedBackgroundImage(previous.imageUri)) {
              await FileSystem.deleteAsync(previous.imageUri!, { idempotent: true }).catch(() => undefined);
            }
            return next;
          } catch (error) {
            if (copied) {
              await FileSystem.deleteAsync(persistentUri, { idempotent: true }).catch(() => undefined);
            }
            throw error;
          }
        });
        if (committed.committed && canCommitBackupRestoreDataEpoch(dataEpoch)) {
          settingsRef.current = committed.value;
          setSettings(committed.value);
        }
      },
      async removeImage() {
        const dataEpoch = captureBackupRestoreDataEpoch();
        if (dataEpoch === null) return;
        const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
          const previous = settingsRef.current;
          const next = { ...previous, imageUri: undefined, mode: 'sky' as const };
          await AsyncStorage.setItem(BACKGROUND_SETTINGS_KEY, JSON.stringify(next));
          if (isManagedBackgroundImage(previous.imageUri)) {
            await FileSystem.deleteAsync(previous.imageUri!, { idempotent: true }).catch(() => undefined);
          }
          return next;
        });
        if (committed.committed && canCommitBackupRestoreDataEpoch(dataEpoch)) {
          settingsRef.current = committed.value;
          setSettings(committed.value);
        }
      },
    }),
    [isReady, settings],
  );

  return <BackgroundPreferencesContext.Provider value={value}>{children}</BackgroundPreferencesContext.Provider>;
}

export function useBackgroundPreferences() {
  const context = useContext(BackgroundPreferencesContext);

  if (!context) {
    throw new Error('useBackgroundPreferences must be used inside BackgroundPreferencesProvider.');
  }

  return context;
}

