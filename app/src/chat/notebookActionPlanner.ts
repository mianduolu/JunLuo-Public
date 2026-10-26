import { hasNotebookCommitment } from '../ai/assistantActionCommitments';
import {
  createNotebookEntry,
  cleanNotebookContent,
  isNotebookEntryAllowedNow,
  loadNotebookSnapshot,
  type NotebookEntry,
  type NotebookEntryDraft,
  type NotebookEntryRequest,
} from './notebookStore';

export type NotebookActionReason =
  | 'hidden-request'
  | 'inner-reaction'
  | 'auto-trigger'
  | 'visible-commitment'
  | 'not-needed'
  | 'disabled'
  | 'cooldown'
  | 'empty-content'
  | 'content-rejected'
  | 'write-failed';

export type NotebookActionResult = {
  attempted: boolean;
  entry?: NotebookEntry;
  ok: boolean;
  reason: NotebookActionReason;
  summary: string;
};

const EXPLICIT_NOTEBOOK_REQUEST_PATTERN =
  /(?:记到|写进|放进|收进|存进|留到).{0,8}(?:小本本|小纸条|本本)|(?:小本本|小纸条|本本).{0,12}(?:记|写|用|记录|收一下)|(?:以后|之后|下次).{0,10}(?:用|记得用).{0,8}(?:小本本|小纸条|本本)/;

function compact(value: string, maxLength: number) {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength).trim();
}

function compactForNotebookComparison(value: string) {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function repeatsNotebookSource(request: NotebookEntryRequest, userText: string) {
  const content = compactForNotebookComparison(request.content);
  if (!content) return false;
  return [request.sourceExcerpt, userText]
    .map((value) => compactForNotebookComparison(value ?? ''))
    .some((source) => source && source === content);
}

function fallbackNotebookRequest(userText: string, assistantText: string): NotebookEntryRequest | null {
  const sourceExcerpt = compact(userText, 120);
  const assistantExcerpt = compact(assistantText, 120);
  if (!sourceExcerpt && !assistantExcerpt) return null;
  return {
    content: assistantExcerpt
      ? `刚刚这一刻有一点想收进小本本：${assistantExcerpt}`
      : '刚刚这一刻有一点想收进小本本。',
    keywords: ['小本本'],
    sourceExcerpt,
    title: '刚刚这一刻',
  };
}

export function shouldAutoCreateNotebookEntry(userText: string, assistantContents: string[]) {
  const assistantText = assistantContents.join('\n');
  return Boolean(
    EXPLICIT_NOTEBOOK_REQUEST_PATTERN.test(userText) ||
    hasNotebookCommitment(assistantContents) ||
    EXPLICIT_NOTEBOOK_REQUEST_PATTERN.test(assistantText),
  );
}

type NotebookActionOptions = {
  assistantContents: string[];
  hiddenRequests: NotebookEntryRequest[];
  mode?: 'legacy' | 'inner_reaction';
  sourceMessageId?: string;
  userText: string;
};

export type NotebookActionPreparation =
  | {
      ready: false;
      result: NotebookActionResult;
    }
  | {
      ready: true;
      draft: NotebookEntryDraft;
      reason: 'hidden-request' | 'inner-reaction' | 'auto-trigger';
    };

export async function prepareNotebookAction(options: NotebookActionOptions): Promise<NotebookActionPreparation> {
  const userText = options.userText.trim();
  const isInnerReaction = options.mode === 'inner_reaction';
  const needsNotebook = options.hiddenRequests.length > 0 || (
    !isInnerReaction && shouldAutoCreateNotebookEntry(userText, options.assistantContents)
  );

  if (!needsNotebook) {
    return { ready: false, result: { attempted: false, ok: false, reason: 'not-needed', summary: '' } };
  }
  const snapshot = await loadNotebookSnapshot();
  if (!snapshot.settings.enabled) {
    return {
      ready: false,
      result: {
        attempted: false,
        ok: false,
        reason: 'disabled',
        summary: '小本本当前是关闭的，我会改口，不把它说成完成。',
      },
    };
  }

  const request = options.hiddenRequests[0] ?? (
    isInnerReaction ? null : fallbackNotebookRequest(userText, options.assistantContents.join('\n'))
  );
  if (!request?.content?.trim() || repeatsNotebookSource(request, userText)) {
    return {
      ready: false,
      result: {
        attempted: false,
        ok: false,
        reason: 'empty-content',
        summary: '这轮没有形成适合小本本的内容，我会改口，不把它说成完成。',
      },
    };
  }

  // Use the storage rule before declaring the draft ready; a rejected text is
  // not a failed disk write and retrying the same draft cannot make it valid.
  if (!cleanNotebookContent(request.content)) {
    return {
      ready: false,
      result: {
        attempted: false,
        ok: false,
        reason: 'content-rejected',
        summary: '这轮没有形成适合小本本的内容，我会改口，不把它说成完成。',
      },
    };
  }

  const sourceType = isInnerReaction
    ? 'assistant_inner_reaction' as const
    : options.hiddenRequests.length
      ? 'assistant_hidden_request' as const
      : 'assistant_auto_guarded' as const;
  if (!isNotebookEntryAllowedNow(snapshot.settings, sourceType)) {
    return {
      ready: false,
      result: {
        attempted: true,
        ok: false,
        reason: 'cooldown',
        summary: '小本本这会儿还在冷却，我会改口，不把它说成完成。',
      },
    };
  }

  return {
    ready: true,
    reason: isInnerReaction
      ? 'inner-reaction'
      : options.hiddenRequests.length
        ? 'hidden-request'
        : 'auto-trigger',
    draft: {
      content: request.content,
      keywords: request.keywords,
      sourceExcerpt: isInnerReaction ? undefined : request.sourceExcerpt || userText,
      sourceMessageId: options.sourceMessageId,
      sourceType,
      title: request.title,
    },
  };
}

export async function commitPreparedNotebookAction(
  preparation: NotebookActionPreparation,
): Promise<NotebookActionResult> {
  if (preparation.ready === false) return preparation.result;
  const entry = await createNotebookEntry(preparation.draft);
  if (!entry) {
    const current = await loadNotebookSnapshot();
    const sourceType = preparation.draft.sourceType ?? 'manual';
    const reason = !current.settings.enabled
      ? 'disabled'
      : !isNotebookEntryAllowedNow(current.settings, sourceType)
        ? 'cooldown'
        : 'write-failed';
    return {
      attempted: true,
      ok: false,
      reason,
      summary: reason === 'cooldown'
        ? '小本本这会儿还在冷却，我会改口，不把它说成完成。'
        : reason === 'disabled'
          ? '小本本当前是关闭的，我会改口，不把它说成完成。'
          : '这轮小本本没有落成，我会改口，不把它说成完成。',
    };
  }
  return {
    attempted: true,
    entry,
    ok: true,
    reason: preparation.reason,
    summary: `已写进白云小本本：${entry.title}`,
  };
}

export async function planNotebookAction(options: NotebookActionOptions): Promise<NotebookActionResult> {
  return commitPreparedNotebookAction(await prepareNotebookAction(options));
}
