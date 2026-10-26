import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { runBackupRestoreDataEpochCommit, captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';

export const CHAT_COMPOSER_DRAFT_KEY = 'junluo.chat.composerDraft.v1';
let writeQueue: Promise<unknown> = Promise.resolve();
let writeRevision = 0;

function saveDraft(text: string) {
  const epoch = captureBackupRestoreDataEpoch();
  const revision = ++writeRevision;
  const write = writeQueue.then(() => revision !== writeRevision ? undefined : runBackupRestoreDataEpochCommit(epoch, () => text.length
    ? AsyncStorage.setItem(CHAT_COMPOSER_DRAFT_KEY, text)
    : AsyncStorage.removeItem(CHAT_COMPOSER_DRAFT_KEY)));
  writeQueue = write.catch(() => undefined);
  return write;
}

type SentDraft = { text: string; revision: number; dataEpoch: number | null };

export function useChatComposerDraft(onStorageError: (message: string) => void) {
  const draftRef = useRef('');
  const revisionRef = useRef(0);
  const [draftResetVersion, setDraftResetVersion] = useState(0);
  const onErrorRef = useRef(onStorageError);
  onErrorRef.current = onStorageError;

  const persist = useCallback((text: string) => {
    void saveDraft(text).catch(() => onErrorRef.current('输入草稿未能保存到本机，请暂时保留文字并稍后再试。'));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const revision = revisionRef.current;
    const dataEpoch = captureBackupRestoreDataEpoch();
    void writeQueue.then(() => AsyncStorage.getItem(CHAT_COMPOSER_DRAFT_KEY)).then(text => {
      if (cancelled || !canCommitBackupRestoreDataEpoch(dataEpoch) || revisionRef.current !== revision || text === null) return;
      draftRef.current = text;
      setDraftResetVersion(current => current + 1);
    }).catch(() => {
      if (!cancelled) onErrorRef.current('输入草稿暂时无法读取，请稍后重新打开聊天。');
    });
    return () => { cancelled = true; };
  }, []);

  const updateDraft = useCallback((text: string) => {
    revisionRef.current += 1;
    draftRef.current = text;
    persist(text);
  }, [persist]);

  const clearDraft = useCallback((preserveStored = false): SentDraft => {
    const text = draftRef.current;
    revisionRef.current += 1;
    draftRef.current = '';
    setDraftResetVersion(current => current + 1);
    if (!preserveStored) persist('');
    return { text, revision: revisionRef.current, dataEpoch: captureBackupRestoreDataEpoch() };
  }, [persist]);

  const finishSend = useCallback((sent: SentDraft | null, saved: boolean) => {
    if (!sent || !canCommitBackupRestoreDataEpoch(sent.dataEpoch) || revisionRef.current !== sent.revision) return;
    if (saved) clearDraft();
    else {
      draftRef.current = sent.text;
      setDraftResetVersion(current => current + 1);
    }
  }, [clearDraft]);

  return { draftRef, draftResetVersion, updateDraft, clearDraft, finishSend };
}
