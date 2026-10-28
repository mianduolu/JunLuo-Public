import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { loadAiRuntimeSnapshot } from '../ai/aiRuntimeScheduler';
import { loadAssistantLifeGenerationDiagnostics } from '../ai/assistantLifeGenerationDiagnostics';
import { subscribeAssistantStateChanged, subscribeNearStatusUpdating } from '../ai/assistantState';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { readUnifiedContactState } from '../proactive/unifiedContactStore';
import { loadAutomaticRemoteAiPolicy } from './automaticRemoteAiPolicy';
import { presentHomeBackgroundAi } from './homeBackgroundAiPresentation';

export async function readHomeBackgroundAiStatus() {
  const [policy, runtime, lifeDiagnostics, contact] = await Promise.all([
    loadAutomaticRemoteAiPolicy({ strict: true }), loadAiRuntimeSnapshot(),
    loadAssistantLifeGenerationDiagnostics(), readUnifiedContactState(),
  ]);
  const checkedAt = Date.now();
  return { checkedAt, view: presentHomeBackgroundAi({ enabled: policy.enabled, now: checkedAt,
    runtime, lifeDiagnostics, contact }) };
}

export function useHomeBackgroundAiStatus(active: boolean) {
  const [foreground, setForeground] = useState(() => AppState.currentState === 'active');
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<typeof readHomeBackgroundAiStatus>> | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => setForeground(state === 'active'));
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!active || !foreground) return;
    setSnapshot(null);
    setReadFailed(false);
    let live = true, reading = false, again = false;
    const refresh = async () => {
      if (!live) return;
      if (reading) { again = true; return; }
      reading = true;
      again = false;
      const epoch = captureBackupRestoreDataEpoch();
      try {
        if (epoch === null) { if (live) setReadFailed(true); return; }
        const next = await readHomeBackgroundAiStatus();
        if (live && !again && canCommitBackupRestoreDataEpoch(epoch)) {
          setSnapshot(next);
          setReadFailed(false);
        } else if (live && !again) {
          setReadFailed(true);
        }
      } catch {
        if (live && !again && canCommitBackupRestoreDataEpoch(epoch)) setReadFailed(true);
      } finally {
        reading = false;
        if (live && again) void refresh();
      }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 15_000);
    const changed = subscribeAssistantStateChanged(() => { void refresh(); });
    const updating = subscribeNearStatusUpdating(() => { void refresh(); });
    return () => { live = false; clearInterval(timer); changed(); updating(); };
  }, [active, foreground]);
  return { snapshot, readFailed };
}
