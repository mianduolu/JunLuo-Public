import AsyncStorage from '@react-native-async-storage/async-storage';
import type { PhoneRestrictionExecutionStatus } from '../backend/phoneRestrictionRecoveryNative';

export const PHONE_RESTRICTION_RECOVERY_NOTICE_KEY = 'junluo.phoneRestriction.recoveryNotice';
export const PHONE_RESTRICTION_RECOVERY_ISSUES = ['usageAccess', 'accessibility', 'overlay', 'collector', 'window'] as const;
export type PhoneRestrictionRecoveryIssue = typeof PHONE_RESTRICTION_RECOVERY_ISSUES[number];
type IssueState = 'fault' | 'clear' | 'unknown';
export type PhoneRestrictionRecoveryNoticeState = { acknowledged: PhoneRestrictionRecoveryIssue[] };
const CONFIRMED_WINDOW_FAILURES = ['ACTIVITY_NOT_ATTACHED', 'ACTIVITY_START_FAILED', 'OVERLAY_ADD_FAILED'];

export function phoneRestrictionRecoveryIssueStates(
  status: PhoneRestrictionExecutionStatus | null,
  now = Date.now(),
): Record<PhoneRestrictionRecoveryIssue, IssueState> {
  const states: Record<PhoneRestrictionRecoveryIssue, IssueState> = {
    usageAccess: 'unknown', accessibility: 'unknown', overlay: 'unknown', collector: 'unknown', window: 'unknown',
  };
  if (!status || status.checkedAt > now + 1000 || now - status.checkedAt > 10_000) return states;
  if (status.restorePaused) {
    for (const issue of PHONE_RESTRICTION_RECOVERY_ISSUES) states[issue] = 'clear';
    return states;
  }
  const { needs, permissions, collector, window } = status;
  states.usageAccess = !needs.usageAccess ? 'clear'
    : permissions.usageAccess === null ? 'unknown' : permissions.usageAccess ? 'clear' : 'fault';
  states.accessibility = !needs.strictPhone ? 'clear'
    : permissions.accessibility === null ? 'unknown'
      : permissions.accessibility && status.accessibilityConnected ? 'clear' : 'fault';
  states.overlay = !needs.overlay || permissions.overlay === true ? 'clear'
    : permissions.overlay === null ? 'unknown' : 'fault';
  states.collector = !needs.collector || collector.running ? 'clear' : collector.starting ? 'unknown' : 'fault';
  if (window.required === false || (!needs.strictPhone && !needs.overlay)) states.window = 'clear';
  else if (window.phoneWindowShowing || window.appOverlayShowing || window.legacyOverlayAttached) states.window = 'clear';
  else if (window.required === true && collector.screenAvailable === true
    && window.lastFailureCode !== null && CONFIRMED_WINDOW_FAILURES.includes(window.lastFailureCode)
    && window.lastFailureAt !== null
    && window.lastFailureAt <= status.checkedAt && status.checkedAt - window.lastFailureAt <= 30_000) {
    // The native layer already confirmed a failed attempt. A newer pending retry does not undo that evidence.
    states.window = 'fault';
  }
  return states;
}

export function parsePhoneRestrictionRecoveryNoticeState(raw: string | null): PhoneRestrictionRecoveryNoticeState {
  try {
    const value = raw === null ? null : JSON.parse(raw);
    const acknowledged = Array.isArray(value?.acknowledged) ? value.acknowledged : [];
    return { acknowledged: PHONE_RESTRICTION_RECOVERY_ISSUES.filter((issue) => acknowledged.includes(issue)) };
  } catch {
    return { acknowledged: [] };
  }
}

export function planPhoneRestrictionRecoveryNotice(
  previous: PhoneRestrictionRecoveryNoticeState,
  status: PhoneRestrictionExecutionStatus | null,
  now = Date.now(),
) {
  const states = phoneRestrictionRecoveryIssueStates(status, now);
  const acknowledged = previous.acknowledged.filter((issue) => states[issue] !== 'clear');
  const issues = PHONE_RESTRICTION_RECOVERY_ISSUES.filter((issue) => states[issue] === 'fault');
  const shouldNotify = issues.some((issue) => !acknowledged.includes(issue));
  return {
    issues,
    shouldNotify,
    state: { acknowledged },
    notifiedState: { acknowledged: PHONE_RESTRICTION_RECOVERY_ISSUES.filter((issue) => acknowledged.includes(issue) || issues.includes(issue)) },
  };
}

// One local issue notice, independent of restriction state and usage accounting.
export function createPhoneRestrictionRecoveryNoticeSession() {
  let generation = 0;
  let lastCheckedAt = 0;
  let state: PhoneRestrictionRecoveryNoticeState | null = null;
  let loaded: Promise<void> | null = null;
  let writes: Promise<unknown> = Promise.resolve();
  function save(next: PhoneRestrictionRecoveryNoticeState) {
    state = next;
    writes = writes.then(() => AsyncStorage.setItem(PHONE_RESTRICTION_RECOVERY_NOTICE_KEY, JSON.stringify(next)))
      .catch(() => undefined);
  }
  return {
    invalidate() { generation += 1; },
    beginRead() { generation += 1; return generation; },
    async observe(
      token: number,
      status: PhoneRestrictionExecutionStatus | null,
      canNotify: () => boolean,
      notify: (issues: PhoneRestrictionRecoveryIssue[]) => void,
      now = Date.now(),
    ) {
      if (state === null) {
        loaded ??= AsyncStorage.getItem(PHONE_RESTRICTION_RECOVERY_NOTICE_KEY)
          .then((raw) => { state = parsePhoneRestrictionRecoveryNoticeState(raw); })
          .catch(() => { state = { acknowledged: [] }; });
        await loaded;
      }
      if (token !== generation || !canNotify() || (status && status.checkedAt < lastCheckedAt && now >= lastCheckedAt)) return;
      const decision = planPhoneRestrictionRecoveryNotice(state!, status, now);
      if (status && status.checkedAt <= now + 1000 && now - status.checkedAt <= 10_000) lastCheckedAt = status.checkedAt;
      if (decision.shouldNotify) {
        notify(decision.issues);
        save(decision.notifiedState);
      } else if (decision.state.acknowledged.join() !== state!.acknowledged.join()) save(decision.state);
    },
    async flush() { await writes; },
  };
}
