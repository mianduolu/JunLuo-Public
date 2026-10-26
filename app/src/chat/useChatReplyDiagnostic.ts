import { useCallback, useState, type SetStateAction } from 'react';
import type { BaiyunChatReplyFailureDiagnosticEntry } from '../ai/behavior/actionChatSemanticStore';

export function useChatReplyDiagnostic() {
  const [error, setErrorValue] = useState<string | null>(null);
  const [diagnostic, setDiagnostic] = useState<BaiyunChatReplyFailureDiagnosticEntry | null>(null);
  const [open, setOpen] = useState(false);
  const clearDiagnostic = useCallback(() => { setDiagnostic(null); setOpen(false); }, []);
  const setError = useCallback((value: SetStateAction<string | null>) => {
    clearDiagnostic();
    setErrorValue(value);
  }, [clearDiagnostic]);
  // Runtime delivers this only after setError, while the session and request still match.
  const onReplyFailureDiagnostic = useCallback((entry: BaiyunChatReplyFailureDiagnosticEntry) => {
    setDiagnostic(entry);
    setOpen(false);
  }, []);
  return { error, setError, diagnostic, modalEntry: open ? diagnostic : null, clearDiagnostic,
    onReplyFailureDiagnostic, openDetails: () => setOpen(true), closeDetails: () => setOpen(false) };
}
