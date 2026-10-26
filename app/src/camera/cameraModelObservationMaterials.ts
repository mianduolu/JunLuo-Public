import { formatChatAfterglowMessageTime } from '../chat/chatAfterglowProbe';
import type { JunLuoToolInputSchema, JunLuoToolResult } from '../tools/toolTypes';
import type { CameraObservationRecordV1 } from './cameraObservationTypes';

export const CAMERA_LOOK_ONCE_TOOL_ID = 'camera.look_once' as const;
export const CAMERA_LOOK_ONCE_TOOL_NAME = '看一眼' as const;
export const CAMERA_LOOK_ONCE_TOOL_DESCRIPTION = 'I 可以选择通过摄像头看一眼，再根据实际看见的内容和 you 说话。' as const;
export const CAMERA_LOOK_ONCE_INPUT_SCHEMA: JunLuoToolInputSchema & { type: 'object' } = {
  type: 'object', properties: {}, required: [], additionalProperties: false,
};

export type CameraModelObservationFailureStage = 'availability' | 'capture' | 'vision' | 'cleanup' | 'persistence';

export type CameraModelObservationResultInput = {
  callId: string;
  startedAt: number;
  finishedAt: number;
} & (
  | { status: 'success'; record: CameraObservationRecordV1; retryUsed: boolean }
  | { status: 'error'; failureStage: CameraModelObservationFailureStage; retryUsed: boolean }
  | { status: 'cancelled' | 'permission_denied' }
);

export type CameraModelObservationSuccessData = {
  observationId: string;
  capturedAt: number;
  sourceKind: CameraObservationRecordV1['sourceKind'];
  retryUsed: boolean;
  observation: CameraObservationRecordV1['result'];
  responseContext?: import('./cameraEvidenceFusion').CameraObservationResponseContext;
};

export type CameraModelObservationFailureData = {
  retryUsed: boolean;
  failureStage: CameraModelObservationFailureStage;
};

/** The caller supplies a committed record whose temporary frame has already been deleted. */
export function buildCameraModelObservationSummary(record: CameraObservationRecordV1): string {
  return [
    '【本次摄像头观察】',
    `拍摄时间：${new Date(record.capturedAt).toISOString()}`,
    `来源：${record.sourceKind}`,
    `画面可用性：${record.result.frameUsability}`,
    `人物身份关联：${record.result.subjectIdentities.length ? '存在已确认的关联，具体对象见结构化结果' : '未确认'}`,
    `整体把握：${record.result.overallConfidence}`,
    `画面摘要：${record.result.sceneSummary}`,
  ].join('\n');
}

/** Formats the final outcome; retries, cleanup and persistence are the execution host's responsibility. */
export function createCameraModelObservationResult(
  input: CameraModelObservationResultInput,
): JunLuoToolResult<CameraModelObservationSuccessData | CameraModelObservationFailureData> {
  const base = {
    callId: input.callId,
    toolId: CAMERA_LOOK_ONCE_TOOL_ID,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
  };
  if (input.status === 'success') {
    return {
      ...base, ok: true, status: 'success',
      summary: buildCameraModelObservationSummary(input.record),
      data: {
        observationId: input.record.observationId,
        capturedAt: input.record.capturedAt,
        sourceKind: input.record.sourceKind,
        retryUsed: input.retryUsed,
        observation: input.record.result,
      },
    };
  }
  if (input.status === 'error') {
    return {
      ...base, ok: false, status: 'error', summary: '本次摄像头观察未完成。',
      data: { retryUsed: input.retryUsed, failureStage: input.failureStage },
      error: { code: 'CAMERA_OBSERVATION_FAILED', message: 'CAMERA_OBSERVATION_FAILED' },
    };
  }
  const cancelled = input.status === 'cancelled';
  const code = cancelled ? 'CANCELLED_BY_YOU' : 'PERMISSION_DENIED';
  return {
    ...base, ok: false, status: input.status,
    summary: cancelled ? '本次摄像头观察已取消。' : '本次摄像头观察未获执行许可。',
    error: { code, message: code },
  };
}

export type CameraModelObservationDeliveredMessage = {
  role: 'I';
  createdAt: number;
  content: string;
};

/** The host supplies only actually delivered I messages, in delivery order, and checks that the turn is still valid. */
export function buildCameraModelObservationLateInstruction(
  deliveredMessages: readonly CameraModelObservationDeliveredMessage[],
): string {
  if (!deliveredMessages.length) return '';
  const messages = deliveredMessages.map(({ role, createdAt, content }) => ({
    role, time: formatChatAfterglowMessageTime(createdAt), content,
  }));
  return `【这一轮的后续结果】\n\nI 这一轮已经对 you 说过：\n${JSON.stringify(messages, null, 2)}\n\n这次接回的是同一次摄像头观察的最终结果。I 接着回应这次实际拿到的结果，不重复已经说过的话。`;
}

/** The host verifies the original reply and live sources, then supplies an approved final camera result. */
export function buildCameraModelObservationInnerMaterial(result: JunLuoToolResult): string {
  if (result.toolId !== CAMERA_LOOK_ONCE_TOOL_ID) return '';
  let summary: string;
  if (result.ok && result.status === 'success') {
    summary = result.summary;
  } else if (result.status === 'error' && result.error?.code === 'CAMERA_OBSERVATION_FAILED') {
    summary = '本次摄像头观察未完成。';
  } else if (result.status === 'cancelled' && result.error?.code === 'CANCELLED_BY_YOU') {
    summary = '本次摄像头观察已取消。';
  } else if (result.status === 'permission_denied' && result.error?.code === 'PERMISSION_DENIED') {
    summary = '本次摄像头观察未获执行许可。';
  } else {
    return '';
  }
  return `【I 这次使用摄像头的记录】\n工具结果时间：${new Date(result.finishedAt).toISOString()}\n${summary}`;
}
