import { useEffect, useRef } from 'react';

import {
  canCommitBackupRestoreDataEpoch,
  subscribeBackupRestoreRuntimeState,
} from '../backup/backupRestoreCoordinator';
import {
  createToolAgentTurnController,
  type JunLuoToolAgentTurnController,
} from '../tools';

export function useChatToolAgentController(): JunLuoToolAgentTurnController {
  const controllerRef = useRef<JunLuoToolAgentTurnController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createToolAgentTurnController({
      canCommitDataEpoch: canCommitBackupRestoreDataEpoch,
    });
  }

  useEffect(() => {
    const controller = controllerRef.current!;
    const unsubscribe = subscribeBackupRestoreRuntimeState((state) => {
      if (state.status !== 'ready') controller.cancel('stale_data_epoch');
    });
    return () => {
      unsubscribe();
      controller.dispose();
    };
  }, []);

  return controllerRef.current;
}
