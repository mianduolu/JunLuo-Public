import { useEffect, useState } from 'react';
import { type StyleProp, type TextStyle } from 'react-native';

import { AppText as Text } from '../components/AppText';

type VoiceHoldLabelProps = {
  blocked?: boolean;
  busy: boolean;
  recording: boolean;
  starting: boolean;
  startedAt: number | null;
  textStyle: StyleProp<TextStyle>;
  recordingTextStyle: StyleProp<TextStyle>;
};

export function VoiceHoldLabel({
  blocked = false,
  busy,
  recording,
  starting,
  startedAt,
  textStyle,
  recordingTextStyle,
}: VoiceHoldLabelProps) {
  const [elapsedSeconds, setElapsedSeconds] = useState(1);

  useEffect(() => {
    if (!recording || !startedAt) {
      setElapsedSeconds(1);
      return;
    }
    const updateElapsed = () => {
      setElapsedSeconds(Math.max(1, Math.ceil((Date.now() - startedAt) / 1000)));
    };
    updateElapsed();
    const timer = setInterval(updateElapsed, 1000);
    return () => clearInterval(timer);
  }, [recording, startedAt]);

  return (
    <Text style={[textStyle, recording && recordingTextStyle]}>
      {blocked
        ? '通话里正在占用麦克风'
        : busy
          ? '正在整理语音...'
          : starting
            ? '正在打开麦克风...'
            : recording
              ? `松开发送 · ${elapsedSeconds}s`
              : '按住说话'}
    </Text>
  );
}
