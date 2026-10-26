import { useEffect } from 'react';
import { Alert, AppState, Platform } from 'react-native';
import {
  readPhoneRestrictionExecutionStatus,
  refreshPhoneRestrictionExecution,
} from '../backend/phoneRestrictionRecoveryNative';
import {
  openPhoneAccessibilitySettings,
  openPhoneOverlaySettings,
  openPhoneUsageAccessSettings,
} from '../backend/phoneActivityNative';
import {
  createPhoneRestrictionRecoveryNoticeSession,
  type PhoneRestrictionRecoveryIssue,
} from '../proactive/phoneRestrictionRecovery';

const issueLabels: Record<PhoneRestrictionRecoveryIssue, string> = {
  usageAccess: '使用情况访问权限已关闭',
  accessibility: '无障碍服务未连接',
  overlay: '屏幕遮挡权限已关闭',
  collector: '手机限制服务未运行',
  window: '限制窗口未能显示',
};

export function PhoneRestrictionRecoveryNotice() {
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const session = createPhoneRestrictionRecoveryNoticeSession();
    let mounted = true;
    let noticeOpen = false;
    let activation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finalTimer: ReturnType<typeof setTimeout> | undefined;
    const canNotify = () => mounted && AppState.currentState === 'active' && !noticeOpen;
    const show = (issues: PhoneRestrictionRecoveryIssue[]) => {
      noticeOpen = true;
      const dismiss = () => { noticeOpen = false; };
      Alert.alert('手机限制需要恢复', `${issues.map((issue) => issueLabels[issue]).join('；')}。`, [
        { text: '稍后处理', style: 'cancel', onPress: dismiss },
        { text: '去恢复', onPress: () => {
          dismiss();
          if (issues.includes('usageAccess')) openPhoneUsageAccessSettings();
          else if (issues.includes('accessibility')) openPhoneAccessibilitySettings();
          else if (issues.includes('overlay')) openPhoneOverlaySettings();
          else void refreshPhoneRestrictionExecution();
        } },
      ], { cancelable: true, onDismiss: dismiss });
    };
    const check = async () => {
      if (!mounted || AppState.currentState !== 'active') return;
      const token = session.beginRead();
      const status = await readPhoneRestrictionExecutionStatus();
      await session.observe(token, status, canNotify, show);
    };
    const clearPending = () => {
      activation += 1;
      if (timer !== undefined) clearTimeout(timer);
      if (finalTimer !== undefined) clearTimeout(finalTimer);
      timer = undefined;
      finalTimer = undefined;
      session.invalidate();
    };
    const resume = async () => {
      clearPending();
      if (!mounted || AppState.currentState !== 'active') return;
      const currentActivation = activation;
      await refreshPhoneRestrictionExecution();
      // Two bounded reads let an asynchronous service/window start settle; no new watchdog.
      if (!mounted || currentActivation !== activation || AppState.currentState !== 'active') return;
      timer = setTimeout(() => { void check(); }, 750);
      finalTimer = setTimeout(() => { void check(); }, 2500);
    };
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void resume();
      else clearPending();
    });
    if (AppState.currentState === 'active') void resume();
    return () => { mounted = false; clearPending(); subscription.remove(); };
  }, []);
  return null;
}
