import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';

export type WithYouFeature = 'body' | 'diary' | 'theater' | 'shiying' | 'anniversary' | 'phone';

export const WITH_YOU_FEATURE_STORAGE_KEY = 'junluo.withYou.lastFeature';

export function isWithYouFeature(value: unknown): value is WithYouFeature {
  return value === 'body' || value === 'diary' || value === 'theater'
    || value === 'shiying' || value === 'anniversary' || value === 'phone';
}

// Preserve the order of rapid choices, including choices across page mounts.
let preferenceWrite: Promise<unknown> = Promise.resolve();

export function saveWithYouFeaturePreference(feature: WithYouFeature): Promise<boolean> {
  const epoch = captureBackupRestoreDataEpoch();
  const pending = preferenceWrite.then(() => runBackupRestoreDataEpochCommit(
    epoch, () => AsyncStorage.setItem(WITH_YOU_FEATURE_STORAGE_KEY, feature),
  )).then(result => result.committed).catch(() => false);
  preferenceWrite = pending;
  return pending;
}

export function useWithYouFeaturePreference(initialNavigationFeature?: WithYouFeature) {
  const [activeFeature, updateFeature] = useState<WithYouFeature>(
    isWithYouFeature(initialNavigationFeature) ? initialNavigationFeature : 'body',
  );
  const explicitlySelected = useRef(isWithYouFeature(initialNavigationFeature));

  useEffect(() => {
    let active = true;
    const epoch = captureBackupRestoreDataEpoch();
    if (!explicitlySelected.current && epoch !== null) {
      void AsyncStorage.getItem(WITH_YOU_FEATURE_STORAGE_KEY).then((stored) => {
        if (active && !explicitlySelected.current && canCommitBackupRestoreDataEpoch(epoch)
          && isWithYouFeature(stored)) updateFeature(stored);
      }).catch(() => {
        // A missing or unreadable preference never requires a replacement write.
      });
    }
    return () => { active = false; };
  }, []);

  const setActiveFeature = useCallback((feature: WithYouFeature) => {
    if (!isWithYouFeature(feature)) return;
    explicitlySelected.current = true;
    updateFeature(feature);
    void saveWithYouFeaturePreference(feature);
  }, []);

  return { activeFeature, setActiveFeature };
}
