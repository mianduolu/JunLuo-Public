import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { loadPendingChatReplyDraft } from './chatStorage';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { listPendingCameraObservationResponses } from '../camera/cameraObservationStore';
import { subscribeFreshCameraManualReply, takeFreshCameraManualReply } from '../camera/cameraObservationResponseDelivery';
import {
  createChatReplyController,
  type ChatReplyControllerOptions,
} from './chatReplyRuntime';
import { useChatToolAgentController } from './useChatToolAgentController';

export type { ChatReplyPhase, RunChatReplyOptions } from './chatReplyRuntime';

export function useChatReplyController(options: ChatReplyControllerOptions) {
  const toolAgentTurnController = useChatToolAgentController();
  const controller = createChatReplyController(options, toolAgentTurnController);
  const latest = useRef({ options, controller });
  latest.current = { options, controller };
  const sessionId = options.sessions.activeSessionRef.current;
  const freshReplyReady = !!sessionId && options.sessions.messagesSessionIdRef.current === sessionId
    && !!options.model.chatConnection && !!options.model.chatKey.trim();
  const historyReady = !!sessionId && options.sessions.messagesSessionIdRef.current === sessionId;
  useEffect(() => {
    let mounted = true;
    const resume = () => {
      if (!sessionId || !historyReady) return;
      void loadPendingChatReplyDraft(sessionId).then(draft => {
        if (mounted && draft) return latest.current.controller.runReply({ sourceSessionId: sessionId, resumeReplyDraft: true });
      }).catch(() => { /* Keep the original; a later local resume can retry the read. */ });
    };
    resume();
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') resume(); });
    return () => { mounted = false; subscription.remove(); };
  }, [sessionId, historyReady]);
  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const requestFresh = () => {
      if (timer) clearTimeout(timer);
      // The camera page's synchronous cleanup+navigation finishes before a reply can start.
      timer = setTimeout(() => {
        if (!mounted) return;
        const { controller, options } = latest.current;
        const targetSessionId = options.sessions.activeSessionRef.current;
        // A cold chat can mount before its history/configuration. Keep the volatile click until ready.
        if (!targetSessionId || options.sessions.messagesSessionIdRef.current !== targetSessionId
          || !options.model.chatConnection || !options.model.chatKey.trim()) return;
        const intent = takeFreshCameraManualReply();
        if (!intent) return;
        const notifyPending = () => {
          if (mounted) options.runtime.setError('摄像头观察已保存，回应等待下次聊天接续。');
        };
        void controller.runReply({ dataEpoch: intent.dataEpoch, sourceSessionId: targetSessionId,
          cameraObservationReply: { observationId: intent.observationId } })
          .then(started => { if (!started) notifyPending(); }).catch(notifyPending);
      }, 0);
    };
    const stop = subscribeFreshCameraManualReply(requestFresh);
    requestFresh();
    return () => { mounted = false; if (timer) clearTimeout(timer); stop(); };
  }, [sessionId, freshReplyReady]);
  useEffect(() => {
    let mounted = true;
    const epoch = captureBackupRestoreDataEpoch();
    // Cold mount may only save an already paid draft. Pending observations cannot start a model.
    if (sessionId && epoch !== null) void listPendingCameraObservationResponses(sessionId).then(async responses => {
      const draft = responses.find(response => response.status === 'draft_ready');
      if (mounted && draft && canCommitBackupRestoreDataEpoch(epoch)) await latest.current.controller.runReply({
        sourceSessionId: sessionId, dataEpoch: epoch, cameraObservationReply: { observationId: draft.observationId, resumeDraft: true },
      });
    }).catch(() => { /* Retain the local draft; next normal reply can retry its save. */ });
    return () => { mounted = false; };
  }, [sessionId]);
  return controller;
}
