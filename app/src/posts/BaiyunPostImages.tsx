import { useEffect, useRef, useState } from 'react';
import { DeviceEventEmitter, Image, Modal, Pressable, ScrollView, View, type GestureResponderEvent, type LayoutRectangle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { AppText as Text } from '../components/AppText';
import { importPostImages, loadPostImageAssets, retainPostDraftImages, releaseAbandonedPostEditorImages, POST_IMAGE_FILES_CHANGED, type PostImageAsset } from './baiyunPostImageFiles';
import { postColors, postStyles as s } from './baiyunPostStyles';
import { usePostNoticeCover } from './BaiyunPostNoticeViewport';

const activeEditorKeys = new Set<string>();
export const recoverPostEditorImages = () => releaseAbandonedPostEditorImages(activeEditorKeys);

type ImageDrag = { id: string; ids: string[]; from: number; to: number | null; startX: number; startY: number;
  originX: number; originY: number; dx: number; dy: number };

export function PostImages({ ids, onRemove, onReorder, onDragStateChange, disabled = false }: {
  ids: readonly string[]; onRemove?: (index: number) => void;
  onReorder?: (ids: string[]) => void; onDragStateChange?: (active: boolean) => void;
  disabled?: boolean;
}) {
  const [assets, setAssets] = useState<Record<string, PostImageAsset>>({});
  const [preview, setPreview] = useState<number | null>(null);
  usePostNoticeCover(preview !== null);
  const [retry, setRetry] = useState(0);
  const [drag, setDrag] = useState<ImageDrag | null>(null);
  const dragging = useRef<ImageDrag | null>(null);
  const layouts = useRef<Record<string, LayoutRectangle>>({});
  const suppressPress = useRef(false);
  const key = JSON.stringify(ids);
  useEffect(() => {
    const subscription = DeviceEventEmitter.addListener(POST_IMAGE_FILES_CHANGED, () => setRetry(value => value + 1));
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.all(ids.map(async id => {
      try { return (await loadPostImageAssets([id]))[0]; } catch { return null; }
    })).then(items => { if (active) setAssets(Object.fromEntries(items.filter(item => item !== null).map(item => [item.id, item]))); });
    return () => { active = false; };
  }, [key, retry]);
  const moveDrag = (event: GestureResponderEvent) => {
    const active = dragging.current;
    if (!active) return;
    const { pageX, pageY } = event.nativeEvent;
    const x = pageX - active.originX, y = pageY - active.originY;
    const to = active.ids.findIndex(id => {
      const box = layouts.current[id];
      return box && x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
    });
    dragging.current = { ...active, to: to < 0 ? null : to, dx: pageX - active.startX, dy: pageY - active.startY };
    setDrag(dragging.current);
  };
  const finishDrag = (commit: boolean, event?: GestureResponderEvent) => {
    if (event) moveDrag(event);
    const active = dragging.current;
    if (!active) return;
    dragging.current = null; setDrag(null);
    // Save only at drop; hovering never writes a draft or changes the persisted order.
    try {
      if (commit && active.to !== null && active.to !== active.from && JSON.stringify(active.ids) === key) {
        const next = [...active.ids];
        next.splice(active.to, 0, next.splice(active.from, 1)[0]);
        onReorder?.(next);
      }
    } finally { onDragStateChange?.(false); }
  };
  useEffect(() => () => {
    if (dragging.current) { dragging.current = null; onDragStateChange?.(false); }
  }, []);
  if (!ids.length) return null;
  const current = preview === null ? null : assets[ids[preview]];
  return <>
    <View style={[s.grid, ids.length > 1 && { columnGap: '2%' }]} onMoveShouldSetResponderCapture={() => dragging.current !== null}
      onResponderTerminationRequest={() => dragging.current === null}
      onTouchMove={moveDrag} onResponderMove={moveDrag}
      onTouchEnd={event => finishDrag(true, event)} onResponderRelease={event => finishDrag(true, event)}
      onTouchCancel={() => finishDrag(false)} onResponderTerminate={() => finishDrag(false)}>
      {ids.map((id, index) => <View key={id} onLayout={event => { layouts.current[id] = event.nativeEvent.layout; }}
        style={[s.tile, onRemove && ids.length === 1 && { width: '48%' }, drag?.id === id && {
          zIndex: 2, elevation: 4, opacity: 0.85, transform: [{ translateX: drag.dx }, { translateY: drag.dy }, { scale: 1.03 }],
        }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={`查看第 ${index + 1} 张图片`}
        accessibilityHint={onReorder && ids.length > 1 ? '长按图片后拖到另一张图片的位置，松手排序；移出图片区松手取消。' : undefined}
        onPressIn={() => { suppressPress.current = false; }} delayLongPress={350}
        onLongPress={onReorder ? event => {
          const box = layouts.current[id];
          if (disabled || dragging.current || ids.length < 2 || !box) return;
          const { pageX, pageY, locationX, locationY } = event.nativeEvent;
          suppressPress.current = true;
          dragging.current = { id, ids: [...ids], from: index, to: index, startX: pageX, startY: pageY,
            originX: pageX - box.x - locationX, originY: pageY - box.y - locationY, dx: 0, dy: 0 };
          setDrag(dragging.current); onDragStateChange?.(true);
        } : undefined} onPress={() => {
        if (suppressPress.current || dragging.current) return;
        setPreview(index); if (!assets[id]) setRetry(value => value + 1);
      }}>
        {assets[id] ? <Image source={{ uri: assets[id].uri }} style={s.thumbnail} resizeMode="cover" onError={() => setAssets(previous => { const next = { ...previous }; delete next[id]; return next; })} />
          : <View style={[s.thumbnail, { justifyContent: 'center', alignItems: 'center' }]}><Text style={s.muted}>图片暂不可用</Text></View>}
      </Pressable>
      {onRemove ? <Pressable accessibilityRole="button" accessibilityLabel={`移除第 ${index + 1} 张`}
        disabled={disabled} style={[s.button, disabled && s.disabled]} onPress={() => onRemove(index)}>
        <Text style={s.link}>×</Text>
      </Pressable> : null}
      {drag?.to === index && drag.id !== id ? <View pointerEvents="none" style={{ position: 'absolute', inset: 0,
        borderWidth: 2, borderColor: postColors.orange, borderRadius: 6 }} /> : null}
    </View>)}</View>
    <Modal visible={preview !== null} onRequestClose={() => setPreview(null)} animationType="fade">
      <SafeAreaView style={s.page}>
        <View style={s.header}><Pressable style={s.button} onPress={() => setPreview(null)}><Text style={s.link}>关闭</Text></Pressable><Text style={[s.muted, s.grow]}>{(preview ?? 0) + 1} / {ids.length}</Text></View>
        <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }} maximumZoomScale={4} minimumZoomScale={1}>
          {current ? <Image onError={() => setAssets(previous => { const next = { ...previous }; delete next[current.id]; return next; })} accessibilityLabel={`第 ${(preview ?? 0) + 1} 张图片`} source={{ uri: current.uri }} resizeMode="contain" style={{ width: '100%', aspectRatio: current.width / current.height }} /> : <View style={s.section}>
            <Text style={s.muted}>图片暂不可用</Text>
            <Pressable style={s.button} onPress={() => setRetry(value => value + 1)}><Text style={s.link}>重新读取图片</Text></Pressable>
          </View>}
        </ScrollView>
        <View style={[s.row, { justifyContent: 'space-between' }]}>
          <Pressable disabled={preview === 0} style={s.button} onPress={() => setPreview(n => Math.max(0, (n ?? 0) - 1))}><Text style={s.link}>上一张</Text></Pressable>
          <Pressable disabled={preview === ids.length - 1} style={s.button} onPress={() => setPreview(n => Math.min(ids.length - 1, (n ?? 0) + 1))}><Text style={s.link}>下一张</Text></Pressable>
        </View>
      </SafeAreaView>
    </Modal>
  </>;
}

/** The caller persists order before unused files can be collected. Transient editors release their own key only. */
export function PostImageEditor({ ids, draftKey, persistent = false, disabled = false, onChange, onBusy, beforeImport }: {
  ids: string[]; draftKey: string; persistent?: boolean; disabled?: boolean;
  onChange: (ids: string[]) => Promise<void>; onBusy: (busy: boolean) => void;
  beforeImport?: () => Promise<void>;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const work = useRef<Promise<unknown>>(Promise.resolve());
  const locked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    if (!persistent) {
      activeEditorKeys.add(draftKey);
      work.current = retainPostDraftImages(draftKey, ids).catch(() => undefined);
    }
    return () => {
      mounted.current = false;
      if (!persistent) void work.current.catch(() => undefined).then(() => retainPostDraftImages(draftKey, []))
        .catch(() => undefined).finally(() => activeEditorKeys.delete(draftKey));
    };
  }, [draftKey, persistent]);
  const run = (action: () => Promise<void>) => {
    if (locked.current || disabled) return;
    locked.current = true; setBusy(true); onBusy(true); setError('');
    work.current = work.current.catch(() => undefined).then(action).catch(() => {
      if (mounted.current) setError('图片操作失败，请重试。');
    }).finally(() => { locked.current = false; if (mounted.current) { setBusy(false); onBusy(false); } });
  };
  const change = async (next: string[]) => {
    await onChange(next);
    if (!persistent) await retainPostDraftImages(draftKey, next);
  };
  return <View style={{ gap: 8 }}>
    <PostImages ids={ids} disabled={busy || disabled || dragging} onRemove={index => run(() => change(ids.filter((_, i) => i !== index)))}
      onReorder={next => run(() => change(next))} onDragStateChange={active => {
        if (mounted.current) { setDragging(active); onBusy(active || locked.current); }
      }} />
    {ids.length > 1 ? <Text style={s.muted}>{dragging ? '拖到目标图片，松手排序；移出图片区松手取消' : '长按图片可拖动排序'}</Text> : null}
    <View style={s.row}><Pressable accessibilityRole="button" disabled={busy || disabled || dragging || ids.length >= 9} style={[s.button, (busy || disabled || dragging || ids.length >= 9) && s.disabled]}
      onPress={() => run(async () => {
        await beforeImport?.();
        await retainPostDraftImages(draftKey, ids);
        const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true,
          selectionLimit: 9 - ids.length, orderedSelection: true, quality: 1 });
        if (result.canceled) return;
        if (result.assets.length > 9 - ids.length) throw new Error('baiyun-post-invalid-images');
        const added = await importPostImages(draftKey, result.assets.map(asset => asset.uri));
        await change([...ids, ...added.map(asset => asset.id)]);
      })}><Text style={s.link}>{busy ? '处理图片中…' : '＋ 图片'}</Text></Pressable><Text style={s.muted}>{ids.length} / 9</Text></View>
    {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
  </View>;
}
