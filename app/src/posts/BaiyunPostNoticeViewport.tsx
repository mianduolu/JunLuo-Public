import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ComponentProps, type RefObject } from 'react';
import { AppState, View, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollView } from 'react-native';
import { markPostNoticesSeen } from './baiyunPostNotice';

type Entry = RefObject<View | null>;
type Viewport = { register: (key: string, ref: Entry) => () => void; changed: () => void; cover: () => () => void };
export const PostNoticeViewportContext = createContext<Viewport | null>(null);

export function postNoticeIsVisible(top: number, height: number, viewportTop: number, viewportHeight: number) {
  const overlap = Math.min(top + height, viewportTop + viewportHeight) - Math.max(top, viewportTop);
  return height > 0 && viewportHeight > 0 && overlap >= Math.min(height, viewportHeight) * 0.6;
}

/** Only mounted arrivals in this viewport: folded, offscreen and covered items stay unread. */
export function usePostNoticeViewport(active: boolean, scroll: RefObject<ScrollView | null>, targetKey?: string) {
  const entries = useRef(new Map<string, Entry>()), acknowledged = useRef(new Set<string>()), pending = useRef(new Set<string>());
  const enabled = useRef(active), mounted = useRef(false), frame = useRef(false), revision = useRef(0), offset = useRef(0);
  const target = useRef(targetKey), positioned = useRef<string | undefined>(undefined);
  const covers = useRef(0);
  const scrollSettled = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  enabled.current = active; target.current = targetKey;
  const changed = useCallback(() => {
    revision.current++;
    if (frame.current || !mounted.current || !enabled.current || AppState.currentState !== 'active') return;
    frame.current = true;
    requestAnimationFrame(() => {
      frame.current = false;
      const version = revision.current;
      const current = () => mounted.current && enabled.current && !covers.current && AppState.currentState === 'active' && version === revision.current;
      if (!current()) return;
      scroll.current?.getNativeScrollRef()?.measureInWindow((_x, viewportTop, _width, viewportHeight) => {
        if (!current() || viewportHeight <= 0) return;
        const destination = target.current;
        const targetView = destination && entries.current.get(destination)?.current;
        if (destination && positioned.current !== destination) {
          if (targetView) targetView.measureInWindow((_tx, top) => {
            if (!current()) return;
            positioned.current = destination;
            scroll.current?.scrollTo({ y: Math.max(0, offset.current + top - viewportTop - 12), animated: false });
            changed();
          });
          return;
        }
        const candidates = [...entries.current].filter(([key]) => !acknowledged.current.has(key) && !pending.current.has(key));
        void Promise.all(candidates.map(([key, ref]) => new Promise<string | null>(resolve => {
          if (!ref.current) { resolve(null); return; }
          ref.current.measureInWindow((_ix, top, _iw, height) => resolve(current() && entries.current.get(key) === ref
            && postNoticeIsVisible(top, height, viewportTop, viewportHeight) ? key : null));
        }))).then(keys => {
          if (!current()) return;
          const seen = keys.filter((key): key is string => key !== null);
          if (!seen.length) return;
          seen.forEach(key => pending.current.add(key));
          void markPostNoticesSeen(seen).then(() => seen.forEach(key => acknowledged.current.add(key)))
            .catch(() => undefined).finally(() => seen.forEach(key => pending.current.delete(key)));
        });
      });
    });
  }, [scroll]);
  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', changed);
    changed();
    return () => { mounted.current = false; revision.current++; clearTimeout(scrollSettled.current); subscription.remove(); };
  }, [changed]);
  useEffect(changed, [active, targetKey, changed]);
  const context = useMemo<Viewport>(() => ({ changed, cover() {
    covers.current++; changed();
    return () => { covers.current--; changed(); };
  }, register(key, ref) {
    entries.current.set(key, ref); changed();
    return () => { if (entries.current.get(key) === ref) entries.current.delete(key); changed(); };
  } }), [changed]);
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    offset.current = event.nativeEvent.contentOffset.y;
    revision.current++;
    // Native measurement happens after scrolling settles, not for every finger-motion frame.
    clearTimeout(scrollSettled.current);
    scrollSettled.current = setTimeout(changed, 120);
  }, [changed]);
  return { context, onScroll, changed };
}

export function PostNoticeView({ noticeKey, ...props }: ComponentProps<typeof View> & { noticeKey?: string }) {
  const context = useContext(PostNoticeViewportContext), ref = useRef<View>(null);
  useEffect(() => noticeKey ? context?.register(noticeKey, ref) : undefined, [context, noticeKey]);
  return <View {...props} ref={ref} collapsable={false} onLayout={event => { props.onLayout?.(event); context?.changed(); }} />;
}

export function usePostNoticeCover(covered: boolean) {
  const context = useContext(PostNoticeViewportContext);
  useEffect(() => covered ? context?.cover() : undefined, [context, covered]);
}
