import { useEffect, useState } from 'react';
import { Keyboard } from 'react-native';

export function useChatAutomaticSyncBusy(input: {
  active: boolean;
  compressingContext: boolean;
  onChange?: (busy: boolean) => void;
  replyBusy: boolean;
  voiceBusy: boolean;
  voiceCaptureActive: boolean;
  voiceRecordingVisible: boolean;
  voiceStarting: boolean;
}) {
  const [keyboardEditing, setKeyboardEditing] = useState(false);

  useEffect(() => {
    if (!input.active) {
      setKeyboardEditing(false);
      return undefined;
    }
    const show = Keyboard.addListener(
      'keyboardDidShow',
      () => setKeyboardEditing(true),
    );
    const hide = Keyboard.addListener(
      'keyboardDidHide',
      () => setKeyboardEditing(false),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, [input.active]);

  useEffect(() => {
    const busy = input.active && (
      keyboardEditing
      || input.replyBusy
      || input.compressingContext
      || input.voiceBusy
      || input.voiceCaptureActive
      || input.voiceRecordingVisible
      || input.voiceStarting
    );
    input.onChange?.(busy);
    return () => input.onChange?.(false);
  }, [
    input.active,
    input.compressingContext,
    input.onChange,
    input.replyBusy,
    input.voiceBusy,
    input.voiceCaptureActive,
    input.voiceRecordingVisible,
    input.voiceStarting,
    keyboardEditing,
  ]);
}
