export const CHAT_HISTORY_RESIDENCY_MARKER_PREFIX = '[JunLuoChatHistoryResidency] ';

export const CHAT_HISTORY_DIAGNOSTIC_PROFILE_CODES = {
  observe: 0,
} as const;

export type ChatHistoryDiagnosticProfile = keyof typeof CHAT_HISTORY_DIAGNOSTIC_PROFILE_CODES;

export const CHAT_HISTORY_RESIDENCY_PHASE_CODES = {
  initialSettled: 1,
  pageLoaded: 2,
  latestSettled: 3,
  chatHidden: 4,
  compacted: 5,
} as const;

export type ChatHistoryResidencyPhase = keyof typeof CHAT_HISTORY_RESIDENCY_PHASE_CODES;

export type ChatHistoryFeatureCounts = {
  imageRowCount: number;
  musicRowCount: number;
  plainRowCount: number;
  richCardRowCount: number;
  stickerRowCount: number;
  voiceCallRowCount: number;
  voiceRowCount: number;
};

export type ChatHistoryMessageShape = {
  goalTimeCreditCard?: unknown;
  id: string;
  images?: readonly unknown[];
  musicCard?: unknown;
  musicCards?: readonly unknown[];
  scheduleChangeCard?: unknown;
  schedulePlanCard?: unknown;
  sticker?: unknown;
  toolCallCards?: readonly unknown[];
  voice?: unknown;
  voiceCallRecord?: unknown;
};

export type ChatHistoryResidencySnapshot = ChatHistoryFeatureCounts & {
  loadedPageMessageCount: number;
  mountedOlderImageRowCount: number;
  mountedOlderMusicRowCount: number;
  mountedOlderPlainRowCount: number;
  mountedOlderRichCardRowCount: number;
  mountedOlderRowCount: number;
  mountedOlderStickerRowCount: number;
  mountedOlderVoiceCallRowCount: number;
  mountedOlderVoicePlayerCount: number;
  mountedOlderVoiceRowCount: number;
  mountedRowCount: number;
  mountedVoicePlayerCount: number;
  phaseCode: number;
  profileCode: number;
  residentMessageCount: number;
  serializedMessageRecordCount: number;
  serializedMessageRecordEstimatedBytes: number;
  stage: 'chat.history_residency';
  v: 1;
};

const emptyFeatureCounts = (): ChatHistoryFeatureCounts => ({
  imageRowCount: 0,
  musicRowCount: 0,
  plainRowCount: 0,
  richCardRowCount: 0,
  stickerRowCount: 0,
  voiceCallRowCount: 0,
  voiceRowCount: 0,
});

function addFeatures(target: ChatHistoryFeatureCounts, source: ChatHistoryFeatureCounts) {
  target.imageRowCount += source.imageRowCount;
  target.musicRowCount += source.musicRowCount;
  target.plainRowCount += source.plainRowCount;
  target.richCardRowCount += source.richCardRowCount;
  target.stickerRowCount += source.stickerRowCount;
  target.voiceCallRowCount += source.voiceCallRowCount;
  target.voiceRowCount += source.voiceRowCount;
}

export function normalizeChatHistoryDiagnosticProfile(
  value: string | undefined,
): ChatHistoryDiagnosticProfile | null {
  return value && Object.hasOwn(CHAT_HISTORY_DIAGNOSTIC_PROFILE_CODES, value)
    ? value as ChatHistoryDiagnosticProfile
    : null;
}

export function classifyChatHistoryMessage(message: ChatHistoryMessageShape): ChatHistoryFeatureCounts {
  const features = {
    imageRowCount: message.images?.length ? 1 : 0,
    musicRowCount: message.musicCards?.length || message.musicCard ? 1 : 0,
    plainRowCount: 0,
    richCardRowCount:
      message.schedulePlanCard
      || message.goalTimeCreditCard
      || message.scheduleChangeCard
      || message.toolCallCards?.length
        ? 1
        : 0,
    stickerRowCount: message.sticker ? 1 : 0,
    voiceCallRowCount: message.voiceCallRecord ? 1 : 0,
    voiceRowCount: message.voice ? 1 : 0,
  };
  features.plainRowCount = Object.values(features).every((count) => count === 0) ? 1 : 0;
  return features;
}

type MountedRow = {
  features: ChatHistoryFeatureCounts;
  older: boolean;
  voicePlayerActive: boolean;
};

export function createChatHistoryResidencyTracker() {
  const loadedPageIds = new Set<string>();
  const mountedRows = new Map<string, MountedRow>();
  const loadedPageFeatures = emptyFeatureCounts();
  let loadedPageRegistered = false;

  const isLoadedPageMessage = (messageId: string) => loadedPageIds.has(messageId);

  return {
    canLoadOlderPage() {
      return !loadedPageRegistered;
    },

    clearLoadedPageIds() {
      loadedPageIds.clear();
    },

    isLoadedPageMessage,

    registerLoadedPage(messages: readonly ChatHistoryMessageShape[]) {
      if (loadedPageRegistered) return false;
      loadedPageRegistered = true;
      for (const message of messages) {
        loadedPageIds.add(message.id);
        addFeatures(loadedPageFeatures, classifyChatHistoryMessage(message));
      }
      return true;
    },

    registerMountedRow(message: ChatHistoryMessageShape) {
      if (mountedRows.has(message.id)) return () => undefined;
      const features = classifyChatHistoryMessage(message);
      const older = isLoadedPageMessage(message.id);
      mountedRows.set(message.id, {
        features,
        older,
        voicePlayerActive: features.voiceRowCount > 0,
      });
      return () => {
        mountedRows.delete(message.id);
      };
    },

    snapshot(
      phase: ChatHistoryResidencyPhase,
      residentMessageCount: number,
      storage: {
        serializedMessageRecordCount: number;
        serializedMessageRecordEstimatedBytes: number;
      },
    ): ChatHistoryResidencySnapshot {
      const mountedOlder = emptyFeatureCounts();
      let mountedOlderRowCount = 0;
      let mountedOlderVoicePlayerCount = 0;
      let mountedVoicePlayerCount = 0;
      for (const row of mountedRows.values()) {
        if (row.voicePlayerActive) mountedVoicePlayerCount += 1;
        if (!row.older) continue;
        mountedOlderRowCount += 1;
        if (row.voicePlayerActive) mountedOlderVoicePlayerCount += 1;
        addFeatures(mountedOlder, row.features);
      }
      return {
        v: 1,
        stage: 'chat.history_residency',
        phaseCode: CHAT_HISTORY_RESIDENCY_PHASE_CODES[phase],
        profileCode: CHAT_HISTORY_DIAGNOSTIC_PROFILE_CODES.observe,
        residentMessageCount,
        ...storage,
        loadedPageMessageCount: loadedPageIds.size,
        ...loadedPageFeatures,
        mountedRowCount: mountedRows.size,
        mountedOlderRowCount,
        mountedVoicePlayerCount,
        mountedOlderVoicePlayerCount,
        mountedOlderImageRowCount: mountedOlder.imageRowCount,
        mountedOlderMusicRowCount: mountedOlder.musicRowCount,
        mountedOlderPlainRowCount: mountedOlder.plainRowCount,
        mountedOlderRichCardRowCount: mountedOlder.richCardRowCount,
        mountedOlderStickerRowCount: mountedOlder.stickerRowCount,
        mountedOlderVoiceCallRowCount: mountedOlder.voiceCallRowCount,
        mountedOlderVoiceRowCount: mountedOlder.voiceRowCount,
      };
    },
  };
}
