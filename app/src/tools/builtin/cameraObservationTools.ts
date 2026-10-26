import { CAMERA_LOOK_ONCE_TOOL_ID, CAMERA_LOOK_ONCE_TOOL_NAME, CAMERA_LOOK_ONCE_TOOL_DESCRIPTION,
  CAMERA_LOOK_ONCE_INPUT_SCHEMA, createCameraModelObservationResult } from '../../camera/cameraModelObservationMaterials';
import type { JunLuoToolDefinition, JunLuoToolPackage } from '../toolTypes';
import { cameraReadObservationsTool } from '../../camera/cameraObservationBook';

export const cameraLookOnceTool: JunLuoToolDefinition = {
  id: CAMERA_LOOK_ONCE_TOOL_ID, packageId: 'camera', name: CAMERA_LOOK_ONCE_TOOL_NAME,
  description: CAMERA_LOOK_ONCE_TOOL_DESCRIPTION, inputSchema: CAMERA_LOOK_ONCE_INPUT_SCHEMA,
  permission: 'allow', riskLevel: 'device_control', readOnly: false, chatExposure: 'internal_only',
  proactiveEligible: false, executionScope: 'local_device', conflictGroup: 'camera.observation',
  agentEpochMode: 'bounded_local_commits', agentSettlementDeadlineMs: 300_000,
  executor: (call, context) => context?.cameraObservation
    ? context.cameraObservation(call)
    : createCameraModelObservationResult({ callId: call.callId, startedAt: Date.now(), finishedAt: Date.now(), status: 'permission_denied' }),
};

export const cameraObservationToolPackage: JunLuoToolPackage = {
  id: 'camera', name: CAMERA_LOOK_ONCE_TOOL_NAME, description: CAMERA_LOOK_ONCE_TOOL_DESCRIPTION,
  category: 'device', tools: [cameraLookOnceTool, cameraReadObservationsTool], defaultEnabled: true, riskLevel: 'device_control', source: 'builtin',
};
