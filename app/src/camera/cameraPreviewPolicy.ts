export type CameraPreviewPolicySession = {
  status: 'stopped' | 'starting' | 'running' | 'paused_camera_busy' | 'paused_permission' | 'paused_system' | 'stopping' | 'error';
  sessionId?: string;
};

export function shouldActivateCameraPreview(input: {
  android: boolean;
  pageVisible: boolean;
  appActive: boolean;
  intentSessionId?: string;
  session?: CameraPreviewPolicySession;
}) {
  return input.android
    && input.pageVisible
    && input.appActive
    && Boolean(input.intentSessionId)
    && input.session?.status === 'running'
    && input.session.sessionId === input.intentSessionId;
}

export function shouldClearCameraPreviewIntent(
  intentSessionId: string | undefined,
  session: CameraPreviewPolicySession,
) {
  if (!intentSessionId) return false;
  return session.status === 'stopped' || session.sessionId !== intentSessionId;
}

export function shouldRequestCameraPreviewFacing(
  phase: 'off' | 'starting' | 'streaming' | 'switching' | 'suspended' | 'error',
  actualFacing: 'front' | 'back' | undefined,
  requestedFacing: 'front' | 'back',
) {
  return phase !== 'streaming' || actualFacing !== requestedFacing;
}
