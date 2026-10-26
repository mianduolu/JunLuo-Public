import { useEffect, useRef, useState } from 'react';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, subscribeBackupRestoreRuntimeState } from '../backup/backupRestoreCoordinator';
import { loadCurrentWishDiscussion } from '../wishPool/wishPoolStore';
import { confirmWishFromChat, continueWishChat, editWishFromChat, isWishChatBusy, subscribeWishChatChanges, openWishInvitation } from '../wishPool/wishPoolChatRuntime';
import { wishConfirmationLabel } from '../wishPool/wishPoolPresentation';
import type { WishDiscussion } from '../wishPool/wishPoolDiscussionState';

const READ_ERROR = '愿望讨论读取失败，请重新进入聊天后重试。';

export type ChatWishControllerState = {
  discussion: WishDiscussion | null;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onContinue: () => void;
  onEdit: () => void;
  castKey: number;
  onCastSettled: () => void;
  onInvite: (messageId: string, callId: string) => void;
};

export function useChatWishController(input: { active: boolean; busy: boolean; sessionId: string | null }): ChatWishControllerState {
  const [discussion, setDiscussion] = useState<WishDiscussion | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [castKey, setCastKey] = useState(0);
  const request = useRef(0);
  const lifecycle = useRef(0);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const currentInput = useRef(input);
  currentInput.current = input;

  const refresh = async () => {
    const version = ++request.current;
    const { active, sessionId } = currentInput.current;
    const epoch = captureBackupRestoreDataEpoch();
    if (!active || !sessionId || epoch === null) { setDiscussion(null); setLoading(false); return; }
    setLoading(true);
    try {
      const next = await loadCurrentWishDiscussion();
      if (!mounted.current || version !== request.current || !canCommitBackupRestoreDataEpoch(epoch)) return;
      setDiscussion(next?.conversationId === sessionId ? next : null);
      setError((previous) => previous === READ_ERROR ? null : previous);
      if (next?.conversationId === sessionId) setCastKey(0);
    } catch {
      if (mounted.current && version === request.current && canCommitBackupRestoreDataEpoch(epoch)) {
        setDiscussion(null); setError(READ_ERROR);
      }
    } finally {
      if (mounted.current && version === request.current) setLoading(false);
    }
  };

  useEffect(() => {
    mounted.current = true;
    lifecycle.current++;
    setDiscussion(null); setError(null); setCastKey(0);
    void refresh();
    const unsubscribe = subscribeWishChatChanges(() => { void refresh(); });
    const restore = subscribeBackupRestoreRuntimeState((state) => {
      if (state.status !== 'ready') {
        request.current++; setDiscussion(null); setLoading(false); setError(null); setCastKey(0);
      } else void refresh();
    });
    return () => { mounted.current = false; lifecycle.current++; request.current++; unsubscribe(); restore(); };
  }, [input.active, input.sessionId]);

  const act = async (kind: 'confirm' | 'continue' | 'edit') => {
    const selected = discussion;
    const epoch = captureBackupRestoreDataEpoch();
    const scope = currentInput.current;
    if (!selected || !scope.active || selected.conversationId !== scope.sessionId || scope.busy
      || loading || inFlight.current || isWishChatBusy() || epoch === null
      || (kind === 'confirm' && !wishConfirmationLabel(selected))) return;
    inFlight.current = true; setPending(true); setError(null);
    const startedIn = lifecycle.current;
    const stillHere = () => mounted.current && currentInput.current.active
      && startedIn === lifecycle.current && currentInput.current.sessionId === scope.sessionId && canCommitBackupRestoreDataEpoch(epoch);
    try {
      if (kind === 'confirm') {
        const saved = await confirmWishFromChat(selected);
        if (stillHere()) {
          setDiscussion(null);
          if (saved.purpose === 'cast_coin' && saved.decision === 'yes') setCastKey((key) => key + 1);
        }
      } else {
        const next = await (kind === 'edit' ? editWishFromChat(selected) : continueWishChat(selected));
        if (stillHere()) setDiscussion(next);
      }
    } catch {
      if (stillHere()) setError('愿望操作未完成，请核对当前讨论后重试。');
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
      if (stillHere()) void refresh();
    }
  };

  const invite = async (messageId: string, callId: string) => {
    const scope = currentInput.current;
    if (!scope.active || !scope.sessionId || scope.busy || loading || inFlight.current || isWishChatBusy()) return;
    inFlight.current = true; setPending(true); setError(null);
    const startedIn = lifecycle.current;
    try { await openWishInvitation(scope.sessionId, messageId, callId); }
    catch {
      if (mounted.current && startedIn === lifecycle.current) setError('邀请未打开；请先处理当前讨论，或到愿望簿核对这颗愿望。');
    } finally {
      inFlight.current = false;
      if (mounted.current) { setPending(false); void refresh(); }
    }
  };
  const visible = input.active && discussion?.conversationId === input.sessionId ? discussion : null;
  return { discussion: visible, busy: input.busy || loading || pending || isWishChatBusy(), error: input.active ? error : null,
    onConfirm: () => { void act('confirm'); }, onContinue: () => { void act('continue'); },
    onEdit: () => { void act('edit'); },
    onCastSettled: () => { if (mounted.current) setCastKey(0); },
    onInvite: (messageId, callId) => { void invite(messageId, callId); }, castKey: input.active ? castKey : 0 };
}
