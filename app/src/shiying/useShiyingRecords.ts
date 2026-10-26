import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import type { ShiyingRecordV1 } from './shiyingJournalContract';
import { listShiyingRecordPreviews, type ShiyingRecordPreview, type ShiyingRecordPreviewCursor } from './shiyingRecordStore';
import { shiyingRecordCoordinator } from './shiyingRecordCoordinator';
import { createShiyingDraftSession, type ShiyingDraftSnapshot } from './shiyingRecordDraft';
import { registerShiyingBackupParticipant } from './shiyingBackupRuntime';
import { shiyingRecordImageFailureStage } from './shiyingRecordImages';

export function useShiyingRecords(active: boolean, callbacks: {
  onEditorPresenceChange?: (open: boolean) => void;
  onEditorClosed?: () => void;
} = {}) {
  const callbacksRef = useRef(callbacks); callbacksRef.current = callbacks;
  const [records, setRecords] = useState<ShiyingRecordPreview[]>([]);
  const [nextBefore, setNextBefore] = useState<ShiyingRecordPreviewCursor | null>(null);
  const [selected, setSelected] = useState<ShiyingRecordV1 | null>(null);
  const [draft, setDraft] = useState<ShiyingDraftSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const sessionRef = useRef<ReturnType<typeof createShiyingDraftSession> | null>(null);
  const writerRef = useRef<ReturnType<typeof shiyingRecordCoordinator.bindEditor> | null>(null);
  const selectedRef = useRef<ShiyingRecordV1 | null>(null);
  const mediaImportRef = useRef<Promise<void> | null>(null);
  const mounted = useRef(true), request = useRef(0), busyRef = useRef(false);
  const actionVersion = useRef(0);
  const activeRef = useRef(active); activeRef.current = active;

  async function refresh() {
    const key = ++request.current;
    setLoading(true);
    try {
      const page = await listShiyingRecordPreviews();
      if (!mounted.current || request.current !== key) return;
      setRecords(page.records); setNextBefore(page.nextBefore); setError('');
    } catch { if (mounted.current && request.current === key) setError('记录暂时无法读取，点此重试。'); }
    finally { if (mounted.current && request.current === key) setLoading(false); }
  }
  async function enter(id?: string, date: 'today' | 'yesterday' = 'today') {
    if (busyRef.current || selectedRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    const version = actionVersion.current;
    try {
      const record = id ? await shiyingRecordCoordinator.open(id) : await shiyingRecordCoordinator.create(date);
      const writer = record?.status === 'draft' ? shiyingRecordCoordinator.bindEditor(record.id, record) : null;
      if (!mounted.current || version !== actionVersion.current) {
        writer?.detach();
        return;
      }
      if (!record) { await refresh(); return; }
      selectedRef.current = record; setSelected(record);
      callbacksRef.current.onEditorPresenceChange?.(true);
      if (writer) {
        writerRef.current = writer;
        const session: ReturnType<typeof createShiyingDraftSession> = createShiyingDraftSession(record, {
          save: writer.save,
          addImage: writer.addImage,
          changed: snapshot => { if (mounted.current && sessionRef.current === session) setDraft(snapshot); },
        });
        sessionRef.current = session; setDraft(session.snapshot());
      } else setDraft(null);
    } catch { if (mounted.current && version === actionVersion.current) setError('记录暂时无法打开，请稍后重试。'); }
    finally { if (version === actionVersion.current) { busyRef.current = false; if (mounted.current) setBusy(false); } }
  }
  async function close() {
    if (busyRef.current || draft?.mediaBusy) return;
    busyRef.current = true; setBusy(true);
    const version = actionVersion.current;
    try {
      if (sessionRef.current) await sessionRef.current.flush(true);
      if (version !== actionVersion.current) return;
      sessionRef.current?.dispose(); sessionRef.current = null;
      writerRef.current = null;
      selectedRef.current = null; setSelected(null); setDraft(null); setError('');
      callbacksRef.current.onEditorPresenceChange?.(false);
      callbacksRef.current.onEditorClosed?.();
      await refresh();
    } catch { /* The session retains the current text and displays its save failure. */ }
    finally { if (version === actionVersion.current) { busyRef.current = false; if (mounted.current) setBusy(false); } }
  }
  async function addImage() {
    const session = sessionRef.current;
    if (!session || busyRef.current || session.snapshot().mediaBusy) return;
    const remaining = 9 - session.snapshot().images.length;
    if (remaining <= 0) { setError('每条记录最多九张图片。'); return; }
    busyRef.current = true; setBusy(true); setError('');
    const version = actionVersion.current;
    let picking = true;
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: false,
        allowsMultipleSelection: true, selectionLimit: remaining, orderedSelection: true, quality: 1 });
      picking = false;
      if (result.canceled) return;
      if (result.assets.length > remaining) throw new Error('shiying_record_image_limit');
      const imports = (async () => {
        for (const asset of result.assets) {
          if (!mounted.current || sessionRef.current !== session) break;
          await session.addImage(asset.uri);
        }
      })();
      mediaImportRef.current = imports;
      try { await imports; } finally { if (mediaImportRef.current === imports) mediaImportRef.current = null; }
    } catch (error) {
      if (mounted.current && sessionRef.current === session) {
        const stage = picking ? 'picker' : shiyingRecordImageFailureStage(error);
        const detail = stage ? { picker: '系统选图', encode: '图片读取或编码', bytes: '图片数据校验', storage: '本机图片目录读取',
          write: '图片文件保存', verify: '图片副本校验', reference: '图片关联保存' }[stage] : null;
        const code = picking && error && typeof error === 'object' && 'code' in error ? error.code : null;
        const nativeCode = typeof code === 'string' && ['E_UNAVAILABLE', 'ERR_MISSING_ACTIVITY_TO_HANDLE_INTENT',
          'ERR_MISSING_MODULE', 'ERR_FAILED_TO_PICK_MEDIA', 'ERR_USER_REJECTED_PERMISSIONS', 'ERR_ARGUMENT_CAST',
          'ERR_INVALID_ARGUMENT', 'ERR_INVALID_ARGS', 'ERR_UNEXPECTED', 'ERR_FAILED_TO_CREATE_FILE',
          'ERR_FAILED_TO_READ_FILE', 'ERR_FAILED_TO_WRITE_FILE'].includes(code) ? ` · ${code}` : '';
        setError(detail ? `图片未能添入（${detail}未完成${nativeCode}），已有文字和图片仍然保留。`
          : '图片未能添入，已有文字和图片仍然保留。');
      }
    }
    finally { if (version === actionVersion.current) { busyRef.current = false; if (mounted.current) setBusy(false); } }
  }
  async function removeSelected() {
    const record = selectedRef.current;
    if (!record || busyRef.current || draft?.mediaBusy || draft?.closing) return;
    busyRef.current = true; setBusy(true);
    const version = actionVersion.current;
    try {
      // Wait for autosave before deleting; otherwise a delayed save could recreate references.
      if (sessionRef.current) await sessionRef.current.flush();
      if (version !== actionVersion.current) return;
      await shiyingRecordCoordinator.remove(record.id, record.updatedAt);
      if (version !== actionVersion.current) return;
      sessionRef.current?.dispose(); sessionRef.current = null;
      writerRef.current = null;
      selectedRef.current = null; setSelected(null); setDraft(null); setError('');
      callbacksRef.current.onEditorPresenceChange?.(false);
      callbacksRef.current.onEditorClosed?.();
      await refresh();
    } catch { if (mounted.current && version === actionVersion.current) setError('记录暂时无法删除，请稍后重试。'); }
    finally { if (version === actionVersion.current) { busyRef.current = false; if (mounted.current) setBusy(false); } }
  }
  async function more() {
    if (!nextBefore || loading) return;
    const key = ++request.current; setLoading(true);
    try {
      const page = await listShiyingRecordPreviews({ before: nextBefore });
      if (!mounted.current || request.current !== key) return;
      setRecords(current => {
        const known = new Set(current.map(record => record.id));
        return [...current, ...page.records.filter(record => !known.has(record.id))];
      }); setNextBefore(page.nextBefore);
    } catch { if (mounted.current && request.current === key) setError('更早的记录暂时无法读取。'); }
    finally { if (mounted.current && request.current === key) setLoading(false); }
  }
  useEffect(() => {
    mounted.current = true;
    const stop = shiyingRecordCoordinator.subscribe(() => {
      if (activeRef.current && !selectedRef.current) void refresh();
    });
    const releaseBackup = registerShiyingBackupParticipant({
      flush: async () => {
        await mediaImportRef.current;
        const session = sessionRef.current;
        if (!session) return;
        do { await session.flush(false); } while (sessionRef.current === session && session.snapshot().status === 'saving');
      },
      invalidate: () => {
        actionVersion.current += 1; request.current += 1;
        sessionRef.current?.invalidate(); sessionRef.current = null;
        mediaImportRef.current = null;
        writerRef.current?.detach(); writerRef.current = null;
        selectedRef.current = null; busyRef.current = false;
        if (mounted.current) {
          setSelected(null); setDraft(null); setRecords([]); setNextBefore(null);
          setBusy(false); setLoading(false); setError('');
          callbacksRef.current.onEditorPresenceChange?.(false);
        }
      },
    });
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') void sessionRef.current?.flush().catch(() => undefined);
      else if (activeRef.current && !selectedRef.current) {
        void shiyingRecordCoordinator.settle().then(() => { if (mounted.current) return refresh(); }).catch(() => {
          if (mounted.current) setError('记录状态暂时无法更新。');
        });
      }
    });
    return () => {
      mounted.current = false; request.current += 1; actionVersion.current += 1;
      stop(); subscription.remove(); releaseBackup();
      const session = sessionRef.current, writer = writerRef.current;
      session?.dispose();
      // A removed page loses its live editor, but keeps the persisted interrupted-writing marker.
      void (session?.flush() ?? Promise.resolve()).catch(() => undefined).finally(() => {
        writer?.detach();
      });
    };
  }, []);
  useEffect(() => {
    if (!active) return;
    void shiyingRecordCoordinator.settle().then(() => { if (mounted.current) return refresh(); }).catch(() => { if (mounted.current) setError('记录状态暂时无法更新。'); });
    void shiyingRecordCoordinator.collect().catch(() => undefined);
  }, [active]);
  return {
    records, nextBefore, selected, draft, busy, loading, error,
    create: () => enter(), createYesterday: () => enter(undefined, 'yesterday'),
    open: (id: string) => enter(id), close, addImage, removeSelected, more, refresh,
    setBody: (body: string) => sessionRef.current?.setBody(body),
    removeImage: (id: string) => { void sessionRef.current?.removeImage(id).catch(() => undefined); },
    retry: () => { void sessionRef.current?.flush().catch(() => undefined); },
  };
}
