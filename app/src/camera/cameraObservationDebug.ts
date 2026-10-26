import * as Crypto from 'expo-crypto';

import { persistCameraObservation } from './cameraObservationStore';
import type { CameraObservationPersistInput } from './cameraObservationTypes';
import type { CameraVisionStructuredResultV1 } from './cameraVisionStructured';

const MAX_SYNTHETIC_OBSERVATIONS = 1_000;

function buildSyntheticResult(index: number): CameraVisionStructuredResultV1 {
  return {
    schemaVersion: 1,
    frameUsability: 'clear',
    subjectVisibility: { status: 'none', visibleCount: 0, subjects: [] },
    subjectIdentities: [],
    objectiveFacts: [{
      factId: 'fact_1',
      category: 'environment',
      subjectRef: null,
      text: `第十一章 Debug 合成观察记录 ${index + 1}，仅用于数据库、分页与备份验收。`,
      evidenceQuality: 'clear',
    }],
    inferences: [],
    uncertainties: [],
    deviceContextFacts: [],
    sceneSummary: `第十一章 Debug 合成观察记录 ${index + 1}；未打开摄像头，也未生成图片。`,
    overallConfidence: 'high',
  };
}

function buildSyntheticInput(batchId: string, index: number, startedAt: number): CameraObservationPersistInput {
  const capturedAt = startedAt - Math.floor(index / 7);
  return {
    actionId: `debug-synthetic-action-${batchId}-${index}`,
    requestId: `debug-synthetic-request-${batchId}-${index}`,
    sessionId: `debug-synthetic-session-${batchId}`,
    triggerKind: 'manual_look',
    sourceKind: index % 2 === 0 ? 'android_front' : 'android_back',
    capturedAt,
    analyzedAt: capturedAt,
    capture: {
      width: 640,
      height: 480,
      rotation: 0,
      mirrored: index % 2 === 0,
    },
    analysis: {
      provider: 'Debug 合成夹具',
      model: '未调用模型',
      latencyMs: 0,
      attemptCount: 1,
      repairUsed: false,
      responseFormatRequested: false,
    },
    result: buildSyntheticResult(index),
    cleanup: {
      cleanupState: 'verified_deleted',
      deletionVerified: true,
      completedAt: capturedAt,
      auditPersisted: false,
    },
  };
}

export async function seedSyntheticCameraObservationsForDebug(
  count: number,
  onProgress?: (completed: number) => void,
) {
  if (!__DEV__) throw new Error('camera_observation_debug_unavailable');
  if (!Number.isInteger(count) || count < 1 || count > MAX_SYNTHETIC_OBSERVATIONS) {
    throw new Error('camera_observation_debug_invalid_count');
  }
  const batchId = Crypto.randomUUID();
  const startedAt = Date.now();
  for (let index = 0; index < count; index += 1) {
    await persistCameraObservation(buildSyntheticInput(batchId, index, startedAt));
    if ((index + 1) % 25 === 0 || index + 1 === count) onProgress?.(index + 1);
  }
  return count;
}
