import { useEffect, useLayoutEffect, useSyncExternalStore, type ReactElement } from 'react';
import { ActivityIndicator, DeviceEventEmitter, NativeModules, Platform, View } from 'react-native';

// A second display surface, never a second App, chat controller or conversation.
const EVENT = 'junluoPhoneLockChatVisibility';
const listeners = new Set<() => void>();
const presentationListeners = new Set<() => void>();
let visible = false;
let visibilityRevision = 0;
let presentation: ReactElement | null = null;
const emit = () => listeners.forEach(listener => listener());
const native = () => Platform.OS === 'android' ? NativeModules.JunLuoPhoneActivity : undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function usePhoneLockChatVisibility() {
  const showing = useSyncExternalStore(subscribe, () => visible, () => false);
  useEffect(() => {
    const apply = (value: boolean) => { visible = value; visibilityRevision += 1; emit(); };
    const subscription = DeviceEventEmitter.addListener(EVENT, (value) => apply(value === true));
    const revision = visibilityRevision;
    let mounted = true;
    void native()?.getPhoneLockChatVisibility?.().then((value: boolean) => {
      if (mounted && revision === visibilityRevision) apply(value === true);
    }).catch(() => undefined);
    return () => { mounted = false; subscription.remove(); };
  }, []);
  return showing;
}

export function PhoneLockChatProjection({ children }: { children: ReactElement }) {
  useLayoutEffect(() => {
    presentation = children;
    presentationListeners.forEach(listener => listener());
    native()?.setPhoneLockChatOwnerReady?.(true);
  }, [children]);
  useLayoutEffect(() => () => {
    presentation = null;
    presentationListeners.forEach(listener => listener());
    native()?.setPhoneLockChatOwnerReady?.(false);
  }, []);
  return null;
}

export function PhoneLockChatSurface() {
  const content = useSyncExternalStore((listener) => {
    presentationListeners.add(listener);
    return () => { presentationListeners.delete(listener); };
  }, () => presentation, () => null);
  return <View style={{ flex: 1 }}>
    {content ?? <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color="#76A8D2" />
    </View>}
  </View>;
}
