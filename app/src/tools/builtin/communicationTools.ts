import { Linking, Share } from 'react-native';

import { createSocialDraft } from '../../life/socialAgent';
import { getToolDefinition } from '../toolRegistry';
import { createToolError } from '../toolErrors';
import { createToolErrorResult, createToolSuccessResult } from '../toolResult';
import type { JunLuoToolCall, JunLuoToolDefinition, JunLuoToolPackage, JunLuoToolResult } from '../toolTypes';
import { readOptionalStringInput, readStringInput, validationFailed } from './builtinToolValidation';
import { DIALER_DESCRIPTION, DIALER_TARGET_DESCRIPTION } from '../chatDialer';

type SmsDraftData = {
  body: string;
  createdAt: number;
  phoneNumber?: string;
  recipientName?: string;
};

type OpenSystemPageData = {
  action: 'open_sms_composer' | 'open_phone_dialer';
  phoneNumber: string;
  urlScheme: 'sms' | 'tel';
};

type ShareTextData = {
  action: 'share_text';
  sharedTextLength: number;
  title?: string;
};

type CommunicationShareFileData = {
  action: 'share_file';
  delegatedToolId: 'files.share';
  resultSummary: string;
};

type SocialDraftData = {
  content: string;
  draftId: string;
  platform: 'junluo';
  status: 'pending';
  title?: string;
};

const PHONE_NUMBER_PATTERN = /^\+?[0-9][0-9\s().-]{2,24}[0-9]$/;

function cleanPhoneNumber(value: string) {
  return value.replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
}

function readPhoneNumber(call: JunLuoToolCall) {
  const raw = readStringInput(call.input, 'phoneNumber') || readStringInput(call.input, 'number');
  if (!raw) return { error: validationFailed(call, 'phoneNumber 不能为空', '没有打开系统页面：缺少号码'), phoneNumber: '' };
  if (!PHONE_NUMBER_PATTERN.test(raw)) {
    return { error: validationFailed(call, 'phoneNumber 格式不安全', '没有打开系统页面：号码格式不安全'), phoneNumber: '' };
  }
  return { error: null, phoneNumber: cleanPhoneNumber(raw) };
}

function executionFailed<TData>(call: JunLuoToolCall, error: unknown, summary: string): JunLuoToolResult<TData> {
  return createToolErrorResult(
    call,
    createToolError('EXECUTION_FAILED', error instanceof Error ? error.message : String(error), error),
    summary,
  );
}

function executeDraftSms(call: JunLuoToolCall): JunLuoToolResult<SmsDraftData> {
  const body = readStringInput(call.input, 'body') || readStringInput(call.input, 'text') || readStringInput(call.input, 'content');
  const phoneNumber = readOptionalStringInput(call.input, 'phoneNumber') || readOptionalStringInput(call.input, 'number');
  const recipientName = readOptionalStringInput(call.input, 'recipientName');
  if (!body) return validationFailed(call, 'body 不能为空', '没有生成短信草稿');
  if (phoneNumber && !PHONE_NUMBER_PATTERN.test(phoneNumber)) {
    return validationFailed(call, 'phoneNumber 格式不安全', '没有生成短信草稿：号码格式不安全');
  }
  return createToolSuccessResult(call, '已准备短信草稿；还没有打开短信 App，也没有发送', {
    body,
    createdAt: Date.now(),
    ...(phoneNumber ? { phoneNumber: cleanPhoneNumber(phoneNumber) } : {}),
    ...(recipientName ? { recipientName } : {}),
  });
}

async function executeOpenSmsComposer(call: JunLuoToolCall): Promise<JunLuoToolResult<OpenSystemPageData>> {
  const parsed = readPhoneNumber(call);
  if (parsed.error) return parsed.error as JunLuoToolResult<OpenSystemPageData>;
  const body = readStringInput(call.input, 'body') || readStringInput(call.input, 'text') || readStringInput(call.input, 'content');
  if (!body) return validationFailed(call, 'body 不能为空', '没有打开短信编辑页');
  try {
    const url = `sms:${encodeURIComponent(parsed.phoneNumber)}?body=${encodeURIComponent(body)}`;
    await Linking.openURL(url);
    return createToolSuccessResult(call, '已打开短信编辑页；短信仍需要用户自己确认发送', {
      action: 'open_sms_composer',
      phoneNumber: parsed.phoneNumber,
      urlScheme: 'sms',
    });
  } catch (error) {
    return executionFailed(call, error, '没有打开短信编辑页');
  }
}

async function executeOpenPhoneDialer(call: JunLuoToolCall, context?: import('../toolTypes').JunLuoToolExecutorContext): Promise<JunLuoToolResult> {
  if (call.requestedBy === 'chat' || Object.prototype.hasOwnProperty.call(call.input, 'target')) {
    return context?.dialerChat ? context.dialerChat(call)
      : createToolErrorResult(call, createToolError('PERMISSION_DENIED', 'DIALER_CHAT_HOST_REQUIRED'), '这次没能打开拨号页。');
  }
  const parsed = readPhoneNumber(call);
  if (parsed.error) return parsed.error as JunLuoToolResult<OpenSystemPageData>;
  try {
    await Linking.openURL(`tel:${encodeURIComponent(parsed.phoneNumber)}`);
    return createToolSuccessResult(call, '已打开拨号页；电话还没有拨出', {
      action: 'open_phone_dialer',
      phoneNumber: parsed.phoneNumber,
      urlScheme: 'tel',
    });
  } catch (error) {
    return executionFailed(call, error, '没有打开拨号页');
  }
}

async function executeShareText(call: JunLuoToolCall): Promise<JunLuoToolResult<ShareTextData>> {
  const text = readStringInput(call.input, 'text') || readStringInput(call.input, 'content') || readStringInput(call.input, 'message');
  const title = readOptionalStringInput(call.input, 'title');
  if (!text) return validationFailed(call, 'text 不能为空', '没有打开分享面板');
  try {
    await Share.share({ message: text, ...(title ? { title } : {}) });
    return createToolSuccessResult(call, '已打开系统分享面板；是否发送仍由用户确认', {
      action: 'share_text',
      sharedTextLength: text.length,
      ...(title ? { title } : {}),
    });
  } catch (error) {
    return executionFailed(call, error, '没有打开分享面板');
  }
}

async function executeShareFile(call: JunLuoToolCall): Promise<JunLuoToolResult<CommunicationShareFileData>> {
  const cacheId = readStringInput(call.input, 'cacheId');
  if (!cacheId) return validationFailed(call, 'cacheId 不能为空', '没有打开文件分享面板');
  const shareTool = getToolDefinition('files.share');
  if (!shareTool?.executor) {
    return createToolErrorResult(
      call,
      createToolError('TOOL_NOT_FOUND', 'files.share 未注册'),
      '没有打开文件分享面板：文件分享工具不可用',
    );
  }
  try {
    const delegated = await shareTool.executor({
      ...call,
      callId: `${call.callId}:files-share`,
      toolId: 'files.share',
      input: { cacheId },
    });
    if (!delegated.ok) {
      return createToolErrorResult(
        call,
        delegated.error ?? createToolError('EXECUTION_FAILED', delegated.summary),
        delegated.summary,
      );
    }
    return createToolSuccessResult(call, '已打开系统文件分享面板；是否发送仍由用户确认', {
      action: 'share_file',
      delegatedToolId: 'files.share',
      resultSummary: delegated.summary,
    });
  } catch (error) {
    return executionFailed(call, error, '没有打开文件分享面板');
  }
}

async function executeDraftSocialPost(call: JunLuoToolCall): Promise<JunLuoToolResult<SocialDraftData>> {
  const content = readStringInput(call.input, 'content') || readStringInput(call.input, 'text') || readStringInput(call.input, 'body');
  const title = readOptionalStringInput(call.input, 'title');
  const reason = readOptionalStringInput(call.input, 'reason') ?? '用户要求写入君落本地社交草稿箱';
  if (!content) return validationFailed(call, 'content 不能为空', '没有写入君落草稿箱');
  const draft = await createSocialDraft({
    content,
    kind: 'post',
    platform: 'junluo',
    reason,
    title,
  });
  if (!draft) {
    return createToolErrorResult(
      call,
      createToolError('EXECUTION_FAILED', '草稿内容未通过君落草稿箱校验'),
      '没有写入君落草稿箱',
    );
  }
  return createToolSuccessResult(call, '已放进君落草稿箱；还没有发布到任何外部平台', {
    content: draft.content,
    draftId: draft.id,
    platform: 'junluo',
    status: 'pending',
    ...(draft.title ? { title: draft.title } : {}),
  });
}

function tool(definition: Omit<JunLuoToolDefinition, 'packageId'>): JunLuoToolDefinition {
  return { ...definition, packageId: 'communication' };
}

export const communicationToolPackage: JunLuoToolPackage = {
  id: 'communication',
  name: '通信、分享与社交草稿',
  description: '准备短信、打开短信/拨号确认界面、打开系统分享面板，并写入君落本地社交草稿箱；不会自动发送、拨出或发布。',
  category: 'communication',
  defaultEnabled: true,
  riskLevel: 'social_action',
  source: 'builtin',
  tools: [
    tool({
      id: 'communication.draft_sms',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      name: '准备短信草稿',
      description: '只生成短信草稿数据，不打开短信 App，不发送短信。',
      inputSchema: {
        type: 'object',
        properties: {
          phoneNumber: { type: 'string', description: '可选收件号码。' },
          recipientName: { type: 'string', description: '可选收件人昵称。' },
          body: { type: 'string', description: '短信正文。' },
        },
        required: ['body'],
      },
      permission: 'ask',
      riskLevel: 'write_local',
      readOnly: false,
      executor: executeDraftSms,
    }),
    tool({
      id: 'communication.open_sms_composer',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      name: '打开短信编辑页',
      description: '用系统短信编辑页预填号码和正文；成功不代表短信已发送。',
      inputSchema: {
        type: 'object',
        properties: {
          phoneNumber: { type: 'string', description: '收件号码。' },
          body: { type: 'string', description: '短信正文。' },
        },
        required: ['phoneNumber', 'body'],
      },
      permission: 'ask',
      riskLevel: 'device_control',
      readOnly: false,
      executor: executeOpenSmsComposer,
    }),
    tool({
      id: 'communication.open_phone_dialer',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      name: '打开拨号页',
      description: DIALER_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: { target: { type: 'string', description: DIALER_TARGET_DESCRIPTION } },
        required: ['target'],
      },
      permission: 'ask',
      riskLevel: 'device_control',
      readOnly: false,
      agentEpochMode: 'bounded_local_commits',
      executor: executeOpenPhoneDialer,
    }),
    tool({
      id: 'communication.share_text',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      name: '打开文字分享面板',
      description: '调用系统分享面板分享文本；成功不代表已经发给某个人。',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要交给系统分享面板的文字。' },
          title: { type: 'string', description: '可选分享标题。' },
        },
        required: ['text'],
      },
      permission: 'ask',
      riskLevel: 'social_action',
      readOnly: false,
      executor: executeShareText,
    }),
    tool({
      id: 'communication.share_file',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      name: '打开文件分享面板',
      description: '根据 files 缓存 cacheId 打开系统文件分享面板；复用 files.share 的缓存边界。',
      inputSchema: {
        type: 'object',
        properties: { cacheId: { type: 'string', description: '已登记文件的 cacheId。' } },
        required: ['cacheId'],
      },
      permission: 'ask',
      riskLevel: 'social_action',
      readOnly: false,
      executor: executeShareFile,
    }),
    tool({
      id: 'communication.draft_social_post',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      name: '写入君落社交草稿箱',
      description: '把公开表达草稿写入君落本地草稿箱；不发布到外部平台。',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '可选草稿标题。' },
          content: { type: 'string', description: '草稿正文。' },
          reason: { type: 'string', description: '写入草稿箱的原因。' },
        },
        required: ['content'],
      },
      permission: 'ask',
      riskLevel: 'write_local',
      readOnly: false,
      executor: executeDraftSocialPost,
    }),
  ],
};
