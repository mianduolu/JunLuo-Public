import type { CameraObservationRecordV1 } from './cameraObservationTypes';
import type { CameraObservationResponseContext } from './cameraEvidenceFusion';
import { buildCameraModelObservationSummary } from './cameraModelObservationMaterials';

/** Chapter 15 text approved verbatim; this is system material, never a fabricated utterance/tool receipt. */
export function buildCameraObservationResponseMaterial(input: {
  record: CameraObservationRecordV1;
  requestedAt: number;
  manualShare: boolean;
  responseContext?: CameraObservationResponseContext;
}) {
  const introduction = input.manualShare
    ? `【you 本次分享的摄像头观察】\n\nyou 在 ${new Date(input.requestedAt).toISOString()} 点击“现在看一眼”，并选择“看完让云云回应”。\nI 接住 you 分享的这一眼，结合眼前对话自然回应。`
    : '【接回当前对话的摄像头观察】\n\n下面是 I 已完成、还等待回应的观察。\nI 按标注的拍摄时间理解这一眼，结合眼前对话自然接住。';
  const { record, responseContext } = input;
  const data = { observationId: record.observationId, capturedAt: record.capturedAt,
    sourceKind: record.sourceKind, observation: record.result, ...(responseContext ? { responseContext } : {}) };
  return `${introduction}\n\n${buildCameraModelObservationSummary(record)}\n\n观察材料：\n${JSON.stringify(data, null, 2)}`;
}
