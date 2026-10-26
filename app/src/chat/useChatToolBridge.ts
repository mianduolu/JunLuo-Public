import { useCallback, useEffect, useRef } from 'react';

import {
  createSubjectiveMessage,
  type SubjectiveMessage,
} from '../ai/subjectiveMessages';
import type { BaiyunChatToolReceiptContext } from './toolCallMessageTypes';
import type { ScheduleDataChangedPayload } from '../schedule/scheduleEvents';
import { dateKey } from '../schedule/scheduleStore';
import {
  createToolExecutionSession,
  executeToolCall,
  executeManualToolCallWithSettlement,
  markToolExecutionSessionCommitted,
  markToolExecutionSessionRolledBack,
  markToolExecutionSessionRunning,
  parseAlarmCreateInputFromText,
  parseBrowserListInputFromText,
  parseBrowserUrlInputFromText,
  parseCommunicationInputFromText,
  parseDeviceSnapshotInputFromText,
  parseDeviceSystemBleInputFromText,
  parseExpenseToolInputFromText,
  parseExternalDangerousFileInputFromText,
  parseExternalFileIdFromText,
  parseExternalFileSearchInputFromText,
  parseFileCacheIdInputFromText,
  parseFileCopyInputFromText,
  parseFileMoveInputFromText,
  parseFileSearchInputFromText,
  parseFileWriteInputFromText,
  parseFileZipInputFromText,
  parseGithubCommentIssueInputFromText,
  parseGithubCreateIssueInputFromText,
  parseGithubCreatePullRequestInputFromText,
  parseGithubFileInputFromText,
  parseGithubIssueCommentsInputFromText,
  parseGithubIssueListInputFromText,
  parseGithubOwnerRepoInputFromText,
  parseGithubPullRequestInputFromText,
  parseGithubPullRequestListInputFromText,
  parseGithubSearchRepositoriesInputFromText,
  parseHttpNamedServiceInputFromText,
  parseImageDescribeInputFromText,
  parseImageGenerateInputFromText,
  parseLocationToolInputFromText,
  parseMemoryGetInputFromText,
  parseMemoryLinkInputFromText,
  parseMemoryPreferenceInputFromText,
  parseMemoryQueryLinksInputFromText,
  parseMemorySearchInputFromText,
  parseMemoryUpdateInputFromText,
  parsePhoneContextAppUsageInputFromText,
  parsePhoneContextNotificationsInputFromText,
  parsePhoneContextRecentActivityInputFromText,
  parsePhoneContextSummaryInputFromText,
  parsePhoneContextWindowSummaryInputFromText,
  parseReminderCreateInputFromText,
  parseResearchAcademicSearchInputFromText,
  parseResearchCompareSourcesInputFromText,
  parseResearchDoiInputFromText,
  parseResearchFetchPageInputFromText,
  parseResearchImageSearchInputFromText,
  parseResearchMultiSearchInputFromText,
  parseResearchSearchInputFromText,
  parseResearchVerifyInputFromText,
  parseStrongAlarmCreateInputFromText,
  parseTodoToolInputsFromText,
  parseVideoGenerateInputFromText,
  parseWorkflowInputFromText,
  registerBuiltinTools,
  routeChatToolIntent,
  isLegacyChatToolExecutionAllowed,
  shouldLegacyChatToolRouteYield,
  type JunLuoToolCall,
  type JunLuoToolExecutionSession,
  type JunLuoToolResult,
  type JunLuoToolStatusChangeEvent,
} from '../tools';
import { MUSIC_REQUEST_PATTERN } from './chatMusicLogic';

type ToolReplyPhase = 'idle' | 'requesting';

type ExecuteChatToolOptions = {
  executionIntentId?: string;
  executionIntentSource?: string;
  deferSessionFinalization?: boolean;
  requestedBy?: 'chat' | 'manual';
  silent?: boolean;
};

type UseChatToolBridgeOptions = {
  activeSessionId: string | null;
  commitMessages: (messages: SubjectiveMessage[]) => void;
  configured: boolean;
  messagesRef: Readonly<{ current: SubjectiveMessage[] }>;
  onNotice: (message: string, durationMs: number) => void;
  onReplyPhaseChange: (phase: ToolReplyPhase) => void;
  onScheduleDataChanged: (payload: ScheduleDataChangedPayload) => void;
  requestToolReply: (
    results: JunLuoToolResult[],
    receiptContexts: BaiyunChatToolReceiptContext[],
  ) => Promise<boolean>;
};

export function useChatToolBridge(options: UseChatToolBridgeOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const toolExecutionSessionsRef = useRef(new Map<string, JunLuoToolExecutionSession>());
  const toolCallsRef = useRef(new Map<string, JunLuoToolCall>());

  useEffect(() => {
    registerBuiltinTools();
  }, []);

  const rememberToolExecutionSession = useCallback((session: JunLuoToolExecutionSession) => {
    session.toolCallIds.forEach((callId) => {
      toolExecutionSessionsRef.current.set(callId, session);
    });
  }, []);

  const upsertToolCallCardMessage = useCallback((event: JunLuoToolStatusChangeEvent) => {
    const { commitMessages, messagesRef } = optionsRef.current;
    const card = event.card;
    const existingIndex = messagesRef.current.findIndex((message) =>
      message.toolCallCards?.some((item) => item.callId === card.callId),
    );
    if (existingIndex >= 0) {
      commitMessages(messagesRef.current.map((message, index) => {
        if (index !== existingIndex || !message.toolCallCards) return message;
        return {
          ...message,
          toolCallCards: message.toolCallCards.map((item) => item.callId === card.callId ? card : item),
        };
      }));
      return;
    }
    commitMessages([
      ...messagesRef.current,
      createSubjectiveMessage('I', '', {
        source: 'tool-call',
        toolCallCards: [card],
      }),
    ]);
  }, []);

  const makeChatToolCall = useCallback((
    toolId: string,
    input: Record<string, unknown>,
    sourceMessageId?: string,
    requestedBy: 'chat' | 'manual' = 'chat',
    executionIntentId?: string,
    executionIntentSource?: string,
  ): JunLuoToolCall => ({
    callId: `chat-tool-${toolId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    toolId,
    input,
    requestedBy,
    createdAt: Date.now(),
    sourceMessageId,
    executionIntentId,
    executionIntentSource,
  }), []);

  const finalizeToolReplySessions = useCallback((
    results: JunLuoToolResult[],
    reason: 'committed' | 'rolled_back',
    rollbackReason: string,
  ) => {
    results.forEach((result) => {
      const session = toolExecutionSessionsRef.current.get(result.callId);
      if (!session) return;
      const nextSession = result.ok && reason === 'committed'
        ? markToolExecutionSessionCommitted(session)
        : markToolExecutionSessionRolledBack(session, rollbackReason);
      rememberToolExecutionSession(nextSession);
    });
  }, [rememberToolExecutionSession]);

  const executeChatTool = useCallback(async (
    toolId: string,
    input: Record<string, unknown>,
    sourceMessageId?: string,
    executeOptions: ExecuteChatToolOptions = {},
  ) => {
    const requestedBy = executeOptions.requestedBy ?? 'chat';
    if (requestedBy === 'chat' && !isLegacyChatToolExecutionAllowed(toolId)) {
      throw new Error('CHAT_TOOL_LEGACY_ROUTE_DISABLED');
    }
    const call = makeChatToolCall(
      toolId,
      input,
      sourceMessageId,
      requestedBy,
      executeOptions.executionIntentId,
      executeOptions.executionIntentSource,
    );
    toolCallsRef.current.set(call.callId, call);
    const session = markToolExecutionSessionRunning(
      createToolExecutionSession({
        sourceMessageId,
        toolCallIds: [call.callId],
      }),
      call.callId,
    );
    rememberToolExecutionSession(session);
    const executionOptions = {
      executionId: session.executionId,
      onStatusChange: executeOptions.silent ? undefined : upsertToolCallCardMessage,
    };
    const result = requestedBy === 'manual' && toolId.startsWith('music.')
      ? await executeManualToolCallWithSettlement(call, {
          ...executionOptions,
          sourceSessionId: optionsRef.current.activeSessionId ?? 'manual',
          onLateResult: (lateResult, dataEpochStillCurrent) => {
            if (!dataEpochStillCurrent) return;
            const currentSession = toolExecutionSessionsRef.current.get(call.callId) ?? session;
            rememberToolExecutionSession(
              lateResult.ok
                ? markToolExecutionSessionCommitted(currentSession)
                : markToolExecutionSessionRolledBack(currentSession, lateResult.summary),
            );
          },
        })
      : await executeToolCall(call, executionOptions);
    if (!executeOptions.deferSessionFinalization) {
      const currentSession = toolExecutionSessionsRef.current.get(call.callId) ?? session;
      rememberToolExecutionSession(
        result.ok
          ? markToolExecutionSessionCommitted(currentSession)
          : markToolExecutionSessionRolledBack(currentSession, result.summary),
      );
    }
    return result;
  }, [makeChatToolCall, rememberToolExecutionSession, upsertToolCallCardMessage]);

  const showToolResultNotice = useCallback((result: JunLuoToolResult, successNotice: string) => {
    optionsRef.current.onNotice(result.ok ? successNotice : result.summary, 2600);
  }, []);

  const isEmptyResearchSearchResult = (result: JunLuoToolResult) => {
    if (result.toolId !== 'research.search' && result.toolId !== 'research.search_with_diagnostics') return false;
    const data = result.data as { results?: unknown } | undefined;
    return result.ok && Array.isArray(data?.results) && data.results.length === 0;
  };

  const replyAfterToolResults = useCallback(async (results: JunLuoToolResult[]) => {
    const {
      configured,
      onReplyPhaseChange,
      requestToolReply,
    } = optionsRef.current;
    const receiptContexts = results.flatMap((result): BaiyunChatToolReceiptContext[] => {
      const call = toolCallsRef.current.get(result.callId);
      return call
        ? [{
            callId: call.callId,
            toolId: call.toolId,
            sourceMessageId: call.sourceMessageId,
            input: call.input,
            result,
          }]
        : [];
    });
    const forgetToolCalls = () => {
      results.forEach((result) => toolCallsRef.current.delete(result.callId));
    };
    if (configured) {
      const replied = await requestToolReply(results, receiptContexts);
      if (replied) {
        finalizeToolReplySessions(results, 'committed', '工具回复已通过回灌检查');
        forgetToolCalls();
        return;
      }
    }
    finalizeToolReplySessions(results, 'rolled_back', '模型回复未提交');
    forgetToolCalls();
    onReplyPhaseChange('idle');
  }, [finalizeToolReplySessions]);

  const handleDirectChatToolIntent = useCallback(async (
    text: string,
    youMessage: SubjectiveMessage,
    outgoingMessages: SubjectiveMessage[],
  ) => {
    const { commitMessages, messagesRef, onReplyPhaseChange, onScheduleDataChanged } = optionsRef.current;
    const route = routeChatToolIntent(text);
    if (route.candidateTools.some((toolId) => [
      'schedule.create_event',
      'todo.create',
      'reminder.create',
      'alarm.create',
      'alarm.strong_create',
      'alarm.list',
      'agent_task.schedule_once',
    ].includes(toolId))) return false;
    if (shouldLegacyChatToolRouteYield(route.candidateTools)) return false;
    if (route.unsupported && !MUSIC_REQUEST_PATTERN.test(text)) {
      const unsupportedReply = route.reason === 'credential_reveal_requires_settings'
        ? 'API Key、Cookie、Token 原文属于危险凭据。普通聊天里不能光明正大展示><\n需要鼠到工具权限里显式授权后，再通过受控回执处理。'
        : '这件事还没有接进君落工具哟><\n等对应工具接上以后，我再真的帮鼠执行。';
      commitMessages([
        ...outgoingMessages,
        createSubjectiveMessage('I', unsupportedReply),
      ]);
      return true;
    }

    if (route.candidateTools.includes('credential.check_configured')) {
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('credential.check_configured', { purpose: 'chat' }, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我拿到这次结果啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('http.call_named_service')) {
      onReplyPhaseChange('requesting');
      const input = parseHttpNamedServiceInputFromText(text);
      const result = await executeChatTool('http.call_named_service', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我拿到这次结果啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('memory.search')) {
      onReplyPhaseChange('requesting');
      const input = parseMemorySearchInputFromText(text);
      const result = await executeChatTool('memory.search', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我查到记忆候选啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('memory.get')) {
      const input = parseMemoryGetInputFromText(text);
      if (!input) return false;
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('memory.get', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我读到这条记忆啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('memory.update')) {
      const input = parseMemoryUpdateInputFromText(text);
      if (!input) return false;
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('memory.update', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我把记忆更新好啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('memory.link')) {
      const input = parseMemoryLinkInputFromText(text);
      if (!input) return false;
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('memory.link', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我把两条记忆连起来啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('memory.query_links')) {
      const input = parseMemoryQueryLinksInputFromText(text);
      if (!input) return false;
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('memory.query_links', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我读到记忆关系啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('memory.update_preference')) {
      onReplyPhaseChange('requesting');
      const input = parseMemoryPreferenceInputFromText(text);
      const result = await executeChatTool('memory.update_preference', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我把偏好记忆更新好啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('body_signal.get_latest')) {
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('body_signal.get_latest', {}, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我读到啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('body_signal.get_battery')) {
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('body_signal.get_battery', {}, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我读到啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('body_signal.get_summary')) {
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('body_signal.get_summary', {}, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我读到啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('system_status.get_time')) {
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('system_status.get_time', {}, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我读到啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('system_status.get_battery')) {
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('system_status.get_battery', {}, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我读到啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('system_status.get_device_status')) {
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('system_status.get_device_status', {}, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我读到啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('system_status.get_device_info')) {
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('system_status.get_device_info', {}, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我读到啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('phone_context.get_permission_status')) {
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('phone_context.get_permission_status', {}, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我读到啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('phone_context.get_app_usage')) {
      const input = parsePhoneContextAppUsageInputFromText(text);
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('phone_context.get_app_usage', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我读到啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('phone_context.get_notifications')) {
      const input = parsePhoneContextNotificationsInputFromText(text);
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('phone_context.get_notifications', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我读到啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('phone_context.get_window_summary')) {
      const input = parsePhoneContextWindowSummaryInputFromText(text);
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('phone_context.get_window_summary', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我读到啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('phone_context.get_recent_activity')) {
      const input = parsePhoneContextRecentActivityInputFromText(text);
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('phone_context.get_recent_activity', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我读到啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('phone_context.summarize_recent_activity')) {
      const input = parsePhoneContextSummaryInputFromText(text);
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('phone_context.summarize_recent_activity', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我读到啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('media.pick_image')) {
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('media.pick_image', {}, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '图片已经收进君落缓存啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('media.open_camera')) {
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('media.open_camera', {}, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '照片已经收进君落缓存啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('media.take_screenshot')) {
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('media.take_screenshot', {}, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '截图已经收进君落缓存啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('image.describe_local')) {
      onReplyPhaseChange('requesting');
      const input = parseImageDescribeInputFromText(text);
      const results: JunLuoToolResult[] = [];
      let describeInput = input;
      if (!describeInput) {
        const pickResult = await executeChatTool('media.pick_image', {}, youMessage.id, { deferSessionFinalization: true });
        results.push(pickResult);
        const pickedCacheId = (pickResult.data as { cacheId?: string } | undefined)?.cacheId;
        if (pickedCacheId) describeInput = { cacheId: pickedCacheId };
      }
      if (describeInput) {
        results.push(await executeChatTool('image.describe_local', describeInput, youMessage.id, { deferSessionFinalization: true }));
      }
      showToolResultNotice(results[results.length - 1], results[results.length - 1]?.ok ? '图片信息读取到啦。' : results[results.length - 1]?.summary);
      await replyAfterToolResults(results);
      return true;
    }

    if (route.candidateTools.includes('image.generate')) {
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('image.generate', parseImageGenerateInputFromText(text), youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('video.generate')) {
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('video.generate', parseVideoGenerateInputFromText(text), youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.summary);
      await replyAfterToolResults([result]);
      return true;
    }
    if (route.candidateTools.includes('files.get_external_access_status')) {
      onReplyPhaseChange('requesting');
      const results: JunLuoToolResult[] = [];
      const statusResult = await executeChatTool('files.get_external_access_status', {}, youMessage.id, { deferSessionFinalization: true });
      results.push(statusResult);
      const statusData = statusResult.data as { hasAllFilesAccess?: boolean } | undefined;
      if (/打开|设置|授权|去设置/.test(text) && !statusData?.hasAllFilesAccess) {
        results.push(await executeChatTool('files.open_external_access_settings', {}, youMessage.id, { deferSessionFinalization: true }));
      }
      const finalResult = results[results.length - 1] ?? statusResult;
      showToolResultNotice(finalResult, finalResult.ok ? '我拿到这次结果啦。' : finalResult.summary);
      await replyAfterToolResults(results);
      return true;
    }

    if (route.candidateTools.includes('files.delete_external_file') ||
      route.candidateTools.includes('files.overwrite_external_file') ||
      route.candidateTools.includes('files.move_external_file')) {
      const toolId = route.candidateTools.find((tool) => tool.startsWith('files.') && tool.endsWith('_external_file'));
      const input = parseExternalDangerousFileInputFromText(text);
      if (!toolId || !input) return false;
      onReplyPhaseChange('requesting');
      const result = await executeChatTool(toolId, input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我把这件事安排好啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('files.import_external_file')) {
      const externalFileId = parseExternalFileIdFromText(text);
      onReplyPhaseChange('requesting');
      if (externalFileId) {
        const result = await executeChatTool('files.import_external_file', { externalFileId }, youMessage.id, { deferSessionFinalization: true });
        showToolResultNotice(result, result.ok ? '我把这件事安排好啦。' : result.summary);
        await replyAfterToolResults([result]);
        return true;
      }
      const searchResult = await executeChatTool(
        'files.search_external_files',
        parseExternalFileSearchInputFromText(text),
        youMessage.id,
        { deferSessionFinalization: true },
      );
      showToolResultNotice(searchResult, searchResult.ok ? '我拿到这次结果啦。' : searchResult.summary);
      await replyAfterToolResults([searchResult]);
      return true;
    }

    if (route.candidateTools.includes('files.search_external_files')) {
      const input = parseExternalFileSearchInputFromText(text);
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('files.search_external_files', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我拿到这次结果啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('files.write_text')) {
      const input = parseFileWriteInputFromText(text);
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('files.write_text', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我把这件事安排好啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('files.copy')) {
      const input = parseFileCopyInputFromText(text);
      if (!input) return false;
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('files.copy', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我把这件事安排好啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('files.move')) {
      const input = parseFileMoveInputFromText(text);
      if (!input) return false;
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('files.move', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我把这件事安排好啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('files.zip')) {
      const input = parseFileZipInputFromText(text);
      if (!input) return false;
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('files.zip', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我把这件事安排好啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('files.unzip')) {
      const input = parseFileCacheIdInputFromText(text) ?? {};
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('files.unzip', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我把这件事安排好啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('files.open')) {
      const input = parseFileCacheIdInputFromText(text);
      if (!input) return false;
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('files.open', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我把这件事安排好啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('files.share')) {
      const input = parseFileCacheIdInputFromText(text);
      if (!input) return false;
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('files.share', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我把这件事安排好啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    const workflowToolId = ['workflow.list_templates', 'workflow.create_from_template', 'workflow.list', 'workflow.get', 'workflow.enable', 'workflow.disable', 'workflow.trigger'].find((toolId) => route.candidateTools.includes(toolId));
    if (workflowToolId) {
      const input = parseWorkflowInputFromText(workflowToolId, text);
      if (!input) return false;
      onReplyPhaseChange('requesting');
      const result = await executeChatTool(workflowToolId, input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '工作流回执拿到啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    const communicationToolId = ['communication.draft_sms', 'communication.open_sms_composer', 'communication.open_phone_dialer', 'communication.share_text', 'communication.share_file', 'communication.draft_social_post'].find((toolId) => route.candidateTools.includes(toolId));
    if (communicationToolId) {
      const input = parseCommunicationInputFromText(communicationToolId, text);
      if (!input) return false;
      onReplyPhaseChange('requesting');
      const result = await executeChatTool(communicationToolId, input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我把这件事准备到安全边界里啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('files.list_recent_imports')) {
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('files.list_recent_imports', { limit: 10 }, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我读到啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('files.pick_document')) {
      onReplyPhaseChange('requesting');
      const results: JunLuoToolResult[] = [];
      const pickResult = await executeChatTool('files.pick_document', {}, youMessage.id, { deferSessionFinalization: true });
      results.push(pickResult);
      const pickedData = pickResult.data as { cacheId?: unknown } | undefined;
      const cacheId = typeof pickedData?.cacheId === 'string' ? pickedData.cacheId : undefined;

      if (cacheId && route.candidateTools.includes('files.file_info')) {
        results.push(await executeChatTool('files.file_info', { cacheId }, youMessage.id, { deferSessionFinalization: true }));
      } else if (cacheId && route.candidateTools.includes('files.search_text')) {
        results.push(await executeChatTool(
          'files.search_text',
          { cacheId, ...parseFileSearchInputFromText(text) },
          youMessage.id,
          { deferSessionFinalization: true },
        ));
      } else if (cacheId && route.candidateTools.includes('files.read_text')) {
        results.push(await executeChatTool('files.read_text', { cacheId }, youMessage.id, { deferSessionFinalization: true }));
      }

      const finalResult = results[results.length - 1] ?? pickResult;
      showToolResultNotice(finalResult, finalResult.ok ? '我拿到这次结果啦。' : finalResult.summary);
      await replyAfterToolResults(results);
      return true;
    }

    if (route.candidateTools.includes('reminder.create')) {
      const input = parseReminderCreateInputFromText(text);
      if (!input) return false;
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('reminder.create', input, youMessage.id, { deferSessionFinalization: true });
      if (result.ok) onScheduleDataChanged({ dateKey: dateKey(input.triggerAt), reason: 'schedule' });
      showToolResultNotice(result, result.ok ? '我把这件事安排好啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('alarm.create')) {
      const input = parseAlarmCreateInputFromText(text);
      if (!input) return false;
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('alarm.create', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(
        result,
        result.ok && input.soundMode === 'music' ? '我把这件事安排好啦。' : '我把这件事安排好啦。',
      );
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('alarm.strong_create')) {
      const input = parseStrongAlarmCreateInputFromText(text);
      if (!input) return false;
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('alarm.strong_create', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我把这件事安排好啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('alarm.list')) {
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('alarm.list', { includePast: false }, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我读到啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    const deviceSystemBleToolId = ['device.list_installed_apps', 'device.get_system_setting', 'device.bluetooth_status', 'device.bluetooth_scan', 'device.colmi_scan'].find((toolId) => route.candidateTools.includes(toolId));
    if (deviceSystemBleToolId) {
      const input = parseDeviceSystemBleInputFromText(deviceSystemBleToolId, text);
      onReplyPhaseChange('requesting');
      const result = await executeChatTool(deviceSystemBleToolId, input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我读到设备状态啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('device.get_accessibility_snapshot')) {
      const input = parseDeviceSnapshotInputFromText(text);
      if (!input) return false;
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('device.get_accessibility_snapshot', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我读到啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('location.get_current_position')) {
      const input = parseLocationToolInputFromText(text);
      if (!input) return false;
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('location.get_current_position', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我拿到这次结果啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('location.get_nearby_world_status')) {
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('location.get_nearby_world_status', {}, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我读到啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('browser.open')) {
      const input = parseBrowserUrlInputFromText(text) ?? {};
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('browser.open', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '我把这件事安排好啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('browser.snapshot')) {
      const input = parseBrowserUrlInputFromText(text) ?? {};
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('browser.snapshot', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '已经读到网页摘要啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('browser.list_tabs')) {
      const input = parseBrowserListInputFromText(text);
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('browser.list_tabs', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '已经读到君落最近网页记录啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('research.search_doi')) {
      const input = parseResearchDoiInputFromText(text);
      if (!input) return false;
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('research.search_doi', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '已经查到 DOI 元数据啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('research.search_academic')) {
      const input = parseResearchAcademicSearchInputFromText(text);
      if (!input) return false;
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('research.search_academic', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '已经查到学术元数据啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('research.search_images')) {
      const input = parseResearchImageSearchInputFromText(text);
      if (!input) return false;
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('research.search_images', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '已经找到公开图片候选啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('research.compare_sources')) {
      const input = parseResearchCompareSourcesInputFromText(text);
      if (!input) return false;
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('research.compare_sources', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '已经完成来源轻量对比啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('research.search_multi')) {
      const input = parseResearchMultiSearchInputFromText(text);
      if (!input) return false;
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('research.search_multi', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '已经查到多源公开网页结果啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }
    if (route.candidateTools.includes('research.fetch_page')) {
      const input = parseResearchFetchPageInputFromText(text);
      if (!input) return false;
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('research.fetch_page', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '已经读到这个网页啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('research.verify_claim')) {
      const input = parseResearchVerifyInputFromText(text);
      if (!input) return false;
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('research.verify_claim', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, result.ok ? '证据验证完成啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (
      route.candidateTools.includes('research.search_with_diagnostics') ||
      route.candidateTools.includes('research.search')
    ) {
      const input = parseResearchSearchInputFromText(text);
      if (!input) return false;
      onReplyPhaseChange('requesting');
      const toolId = route.candidateTools.includes('research.search_with_diagnostics')
        ? 'research.search_with_diagnostics'
        : 'research.search';
      const result = await executeChatTool(toolId, input, youMessage.id, { deferSessionFinalization: true });
      const noSearchResult = isEmptyResearchSearchResult(result);
      showToolResultNotice(result, result.ok && !noSearchResult ? '已经查到公开网页结果啦。' : result.summary);
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.candidateTools.includes('expense.create_entry')) {
      const input = parseExpenseToolInputFromText(text);
      if (!input) return false;
      onReplyPhaseChange('requesting');
      const result = await executeChatTool('expense.create_entry', input, youMessage.id, { deferSessionFinalization: true });
      showToolResultNotice(result, '已经记进小账本啦。');
      await replyAfterToolResults([result]);
      return true;
    }

    if (route.reason === 'explicit_todo_list' && route.candidateTools.includes('todo.create')) {
      const inputs = parseTodoToolInputsFromText(text);
      if (!inputs.length) return false;
      onReplyPhaseChange('requesting');
      const results: JunLuoToolResult[] = [];
      for (const input of inputs) {
        results.push(await executeChatTool('todo.create', input, youMessage.id, { deferSessionFinalization: true }));
      }
      const okCount = results.filter((result) => result.ok).length;
      onScheduleDataChanged({ reason: 'todo' });
      showToolResultNotice(
        results.every((result) => result.ok) ? results[0] : results.find((result) => !result.ok) ?? results[0],
        okCount === inputs.length ? `已经创建 ${okCount} 条待办啦。` : `创建了 ${okCount} 条待办，另有 ${inputs.length - okCount} 条没有完成。`,
      );
      await replyAfterToolResults(results);
      return true;
    }

    return false;
  }, [executeChatTool, replyAfterToolResults, showToolResultNotice]);

  return {
    executeChatTool,
    handleDirectChatToolIntent,
    showToolResultNotice,
  };
}
