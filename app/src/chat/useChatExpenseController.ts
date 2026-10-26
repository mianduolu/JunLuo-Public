import { useCallback, useEffect, useRef, useState } from 'react';

import { createSubjectiveMessage, type SubjectiveMessage } from '../ai/subjectiveMessages';
import type { AiConnection } from '../ai/types';
import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import type { ExpenseDraft } from '../expense/expenseStore';
import { walletChatCopy } from '../expense/walletChatCopy';
import {
  buildWalletChatDecisionFromText,
  classifyWalletChatIntent,
  type WalletChatPipelineInput,
  type WalletChatPipelineResult,
  type WalletDecisionReviewAction,
} from '../expense/walletChatPipeline';
import { resolveWalletBuyNav } from '../expense/walletDecisionNavService';
import { consumeWalletChatNotices, requestOpenWalletTab } from '../expense/walletNavigation';
import {
  approveWalletBuyDecisionOnce as approveWalletBuyDecision,
} from '../expense/walletExecutionOnce';
import {
  approveWalletDecision,
  createWalletDecision,
  loadOrCreateDefaultWallet,
  loadOrCreateWalletPreferences,
  loadWalletHoldings,
  loadWalletTransactions,
  updateWalletDecisionStatus,
} from '../expense/walletStore';

export type ExpenseReviewAction = {
  draft: ExpenseDraft;
  reviewId: string;
};

type WalletChatPreparedContext = Pick<
  WalletChatPipelineInput,
  'holdings' | 'transactions' | 'wallet' | 'walletPreferences'
>;

type UseChatExpenseControllerOptions = {
  active: boolean;
  chatConnection?: AiConnection;
  chatKey: string;
  commitMessages: (nextMessages: SubjectiveMessage[]) => void;
  configured: boolean;
  createExpenseEntry: (draft: ExpenseDraft, reviewId: string) => Promise<boolean>;
  externalMessageVersion: number;
  getUtilityJsonModel: () => { apiKey: string; connection: AiConnection };
  messagesRef: { readonly current: SubjectiveMessage[] };
  onEmptyExpenseNote: () => void;
  onExternalWalletNoticesApplied: () => void;
  onNavigateToWallet: () => void;
  onNotice: (message: string, durationMs: number) => void;
};

export function useChatExpenseController(options: UseChatExpenseControllerOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [expenseReviews, setExpenseReviews] = useState<ExpenseReviewAction[]>([]);
  const [walletDecisionReviews, setWalletDecisionReviews] = useState<WalletDecisionReviewAction[]>([]);
  const [editingExpenseReviewId, setEditingExpenseReviewId] = useState<string | null>(null);
  const [editingExpenseNote, setEditingExpenseNote] = useState('');

  const pushWalletChatNotice = useCallback((text: string) => {
    const { commitMessages, messagesRef } = optionsRef.current;
    commitMessages([...messagesRef.current, createSubjectiveMessage('I', text)]);
  }, []);

  useEffect(() => {
    if (!options.active) return;
    const notices = consumeWalletChatNotices();
    if (!notices.length) return;
    const { commitMessages, messagesRef, onExternalWalletNoticesApplied } = optionsRef.current;
    commitMessages([
      ...messagesRef.current,
      ...notices.map((notice) => createSubjectiveMessage('I', notice)),
    ]);
    onExternalWalletNoticesApplied();
  }, [options.active, options.externalMessageVersion]);


  const prepareWalletChatContext = useCallback(async (text: string): Promise<WalletChatPreparedContext> => {
    const wallet = await loadOrCreateDefaultWallet({ initialBudget: 100 });
    const holdingsPromise = loadWalletHoldings(wallet.id);
    if (classifyWalletChatIntent(text) !== 'wallet_decision') {
      return { holdings: await holdingsPromise, wallet };
    }
    const [holdings, transactions, walletPreferences] = await Promise.all([
      holdingsPromise,
      loadWalletTransactions(wallet.id),
      loadOrCreateWalletPreferences(wallet.id),
    ]);
    if (!walletPreferences) throw new Error('wallet-preferences-unavailable');
    return { holdings, transactions, wallet, walletPreferences };
  }, []);

  const resolveWalletChatIntent = useCallback((
    text: string,
    context: WalletChatPreparedContext,
  ): Promise<WalletChatPipelineResult> => {
    const { chatConnection, chatKey } = optionsRef.current;
    return buildWalletChatDecisionFromText({
      apiKey: chatKey.trim(),
      connection: chatConnection,
      ...context,
      text,
    });
  }, []);

  const applyWalletChatResult = useCallback((result: WalletChatPipelineResult) => {
    if (result.kind === 'decision_ready') {
      setWalletDecisionReviews((current) => [...current, result.review]);
      pushWalletChatNotice(result.notice);
      return;
    }
    if (result.kind === 'open') {
      requestOpenWalletTab({ source: 'chat' });
      pushWalletChatNotice(result.notice);
      optionsRef.current.onNavigateToWallet();
      return;
    }
    pushWalletChatNotice(result.notice);
  }, [pushWalletChatNotice]);

  const reportWalletUnavailable = useCallback(() => {
    pushWalletChatNotice(walletChatCopy.candidateUnavailable);
  }, [pushWalletChatNotice]);

  const dismissExpenseReview = useCallback((reviewId: string) => {
    setExpenseReviews((current) => current.filter((review) => review.reviewId !== reviewId));
    if (editingExpenseReviewId === reviewId) {
      setEditingExpenseReviewId(null);
      setEditingExpenseNote('');
    }
  }, [editingExpenseReviewId]);

  const clearExpenseReviews = useCallback(() => {
    setExpenseReviews([]);
  }, []);

  const beginEditingExpenseReview = useCallback((review: ExpenseReviewAction) => {
    setEditingExpenseReviewId(review.reviewId);
    setEditingExpenseNote(review.draft.note);
  }, []);

  const cancelEditingExpenseReview = useCallback(() => {
    setEditingExpenseReviewId(null);
    setEditingExpenseNote('');
  }, []);

  const updateEditingExpenseNote = useCallback((value: string) => {
    setEditingExpenseNote(value);
  }, []);

  const saveExpenseReviewNote = useCallback((reviewId: string) => {
    const note = editingExpenseNote.trim();
    if (!note) {
      optionsRef.current.onEmptyExpenseNote();
      return;
    }

    setExpenseReviews((current) => current.map((review) => (
      review.reviewId === reviewId
        ? { ...review, draft: { ...review.draft, note } }
        : review
    )));
    setEditingExpenseReviewId(null);
    setEditingExpenseNote('');
  }, [editingExpenseNote]);

  const saveExpenseReview = useCallback(async (review: ExpenseReviewAction) => {
    const saved = await optionsRef.current.createExpenseEntry(review.draft, review.reviewId);
    if (!saved) return;
    setExpenseReviews((current) => current.filter((item) => item.reviewId !== review.reviewId));
    if (editingExpenseReviewId === review.reviewId) {
      setEditingExpenseReviewId(null);
      setEditingExpenseNote('');
    }
    optionsRef.current.onNotice(`已经记进小账本啦：${review.draft.note}`, 2600);
  }, [editingExpenseReviewId]);

  const dismissWalletDecisionReview = useCallback((reviewId: string) => {
    setWalletDecisionReviews((current) => current.filter((review) => review.reviewId !== reviewId));
  }, []);

  const saveWalletDecisionReview = useCallback(async (review: WalletDecisionReviewAction) => {
    const dataEpoch = captureBackupRestoreDataEpoch();
    const candidateNav = review.candidate.latestValue;
    const suggestedNav = Number.isFinite(candidateNav) && candidateNav && candidateNav > 0 ? candidateNav : null;
    try {
      const walletCommit = await runBackupRestoreDataEpochCommit(
        dataEpoch,
        () => loadOrCreateDefaultWallet({ initialBudget: 100 }),
      );
      if (!walletCommit.committed) return;
      const wallet = walletCommit.value;
      const navResult = review.draft.action === 'buy'
        ? await resolveWalletBuyNav({ fundCode: review.draft.fundCode })
        : null;
      const executionNav = navResult?.ok ? navResult.nav : null;
      if (review.draft.action === 'buy' && !executionNav) {
        if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
        pushWalletChatNotice(walletChatCopy.candidateUnavailable);
        return;
      }
      const decisionCommit = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
        const decision = await createWalletDecision(wallet.id, {
          ...review.draft,
          source: 'chat',
          suggestedNav: navResult?.nav ?? suggestedNav,
          suggestedNavAt: navResult?.resolvedAt ?? (suggestedNav ? Date.now() : null),
          suggestedNavSource: navResult?.source === 'none' ? null : (navResult?.source ?? (suggestedNav ? 'candidate_latest_value' : null)),
        });
        if (review.draft.action === 'buy') {
          await approveWalletBuyDecision({ decisionId: decision.id, nav: executionNav ?? 0 });
        } else {
          await approveWalletDecision({ decisionId: decision.id });
        }
      });
      if (!decisionCommit.committed) return;
      setWalletDecisionReviews((current) => current.filter((item) => item.reviewId !== review.reviewId));
      optionsRef.current.onNotice(walletChatCopy.saved, 2600);
      pushWalletChatNotice(walletChatCopy.saved);
    } catch {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      pushWalletChatNotice(walletChatCopy.candidateUnavailable);
    }
  }, [pushWalletChatNotice]);

  const markWalletDecisionReview = useCallback(async (
    review: WalletDecisionReviewAction,
    status: 'deferred' | 'rejected',
  ) => {
    const dataEpoch = captureBackupRestoreDataEpoch();
    try {
      const candidateNav = review.candidate.latestValue;
      const suggestedNav = Number.isFinite(candidateNav) && candidateNav && candidateNav > 0 ? candidateNav : null;
      const decisionCommit = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
        const wallet = await loadOrCreateDefaultWallet({ initialBudget: 100 });
        const decision = await createWalletDecision(wallet.id, {
          ...review.draft,
          source: 'chat',
          suggestedNav,
          suggestedNavAt: suggestedNav ? Date.now() : null,
          suggestedNavSource: suggestedNav ? 'candidate_latest_value' : null,
        });
        await updateWalletDecisionStatus(decision.id, status);
      });
      if (!decisionCommit.committed) return;
      setWalletDecisionReviews((current) => current.filter((item) => item.reviewId !== review.reviewId));
      pushWalletChatNotice(status === 'deferred' ? walletChatCopy.deferred : walletChatCopy.rejected);
    } catch {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      pushWalletChatNotice(walletChatCopy.candidateUnavailable);
    }
  }, [pushWalletChatNotice]);

  const openWalletFromReview = useCallback((review: WalletDecisionReviewAction) => {
    requestOpenWalletTab({
      fundCode: review.draft.fundCode || review.candidate.code,
      fundName: review.draft.fundName || review.candidate.name,
      source: 'chat',
    });
    optionsRef.current.onNavigateToWallet();
  }, []);

  return {
    applyWalletChatResult,
    beginEditingExpenseReview,
    cancelEditingExpenseReview,
    clearExpenseReviews,
    dismissExpenseReview,
    dismissWalletDecisionReview,
    editingExpenseNote,
    editingExpenseReviewId,
    expenseReviews,
    markWalletDecisionReview,
    openWalletFromReview,
    prepareWalletChatContext,
    reportWalletUnavailable,
    resolveWalletChatIntent,
    saveExpenseReview,
    saveExpenseReviewNote,
    saveWalletDecisionReview,
    updateEditingExpenseNote,
    walletDecisionReviews,
  };
}
