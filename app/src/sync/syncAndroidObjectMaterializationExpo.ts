import {
  materializeAppearanceBackgroundObject,
} from './syncAppearanceBackgroundAsyncStoragePort';
import {
  materializeAppearanceFontObject,
} from './syncAppearanceFontsApply';
import {
  AndroidSyncObjectMaterializationRuntime,
  createCompleteAndroidSyncObjectConsumerRegistry,
  type AndroidSyncObjectMaterializer,
} from './syncAndroidObjectMaterializationCore';
import {
  createAndroidSyncObjectTransferRuntime,
} from './syncAndroidObjectTransferExpo';
import {
  materializeSyncChatObject,
} from './syncChatCoreAsyncStoragePort';
import {
  listCurrentSyncObjectReferences,
  listVerifiedSyncObjectJobs,
  loadSyncObjectJob,
  loadSyncObjectMaterializationState,
  saveSyncObjectMaterializationState,
} from './syncObjectJobStore';
import {
  materializePersonaStickerObject,
} from './syncPersonaExpressionObjectsAsyncStoragePort';
import {
  materializeReadingObject,
} from './syncReadingObjectsAsyncStoragePort';
import {
  materializeResearchMaterialsObject,
} from './syncResearchMaterialsObjectApply';
import {
  materializeTogetherWalkedObject,
} from './syncTogetherWalkedLifeAsyncStoragePort';
import {
  materializeToolsWorkspaceFileObject,
} from './syncToolsWorkspaceAsyncStoragePort';
import { materializeBaiyunPostImageObject } from './syncBaiyunPostImagesMaterialization';

const productionMaterializers:
readonly AndroidSyncObjectMaterializer[] = [
  { adapterId: 'gifts.life', materializeVerifiedObject: async input => {
    const { materializeAndroidGiftObject } = await import('./syncGiftsRuntime');
    return materializeAndroidGiftObject(input);
  } },
  {
    adapterId: 'chat.objects',
    materializeVerifiedObject: materializeSyncChatObject,
  },
  { adapterId: 'memory.records', materializeVerifiedObject: materializeBaiyunPostImageObject },
  {
    adapterId: 'persona.expression-objects',
    materializeVerifiedObject: (input) => (
      materializePersonaStickerObject(input)
    ),
  },
  {
    adapterId: 'reading.objects',
    materializeVerifiedObject: (input) => (
      materializeReadingObject(input)
    ),
  },
  {
    adapterId: 'together-walked.life',
    materializeVerifiedObject: (input) => (
      materializeTogetherWalkedObject(input)
    ),
  },
  {
    adapterId: 'tools.workspace',
    materializeVerifiedObject: (input) => (
      materializeToolsWorkspaceFileObject(input)
    ),
  },
  {
    adapterId: 'appearance.fonts',
    materializeVerifiedObject: (input) => (
      materializeAppearanceFontObject(input)
    ),
  },
  {
    adapterId: 'appearance.background',
    materializeVerifiedObject: (input) => (
      materializeAppearanceBackgroundObject(input)
    ),
  },
  {
    adapterId: 'research.materials',
    materializeVerifiedObject: (input) => (
      materializeResearchMaterialsObject(input)
    ),
  },
];

export async function createAndroidSyncObjectMaterializationRuntime(
  input: {
    baseUrl: string;
    timeoutMs?: number;
  },
) {
  const transfer = await createAndroidSyncObjectTransferRuntime(input);
  const consumers =
    createCompleteAndroidSyncObjectConsumerRegistry(
      productionMaterializers,
    );
  return new AndroidSyncObjectMaterializationRuntime(
    transfer,
    {
      loadJob: loadSyncObjectJob,
      listVerifiedJobs: listVerifiedSyncObjectJobs,
      listCurrentReferences: listCurrentSyncObjectReferences,
      loadState: loadSyncObjectMaterializationState,
      saveState: saveSyncObjectMaterializationState,
    },
    consumers,
  );
}
