import { forwardRef, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, type PressableProps, type TextInput, type TextInputProps } from 'react-native';

import { AppText as Text, AppTextInput } from '../components/AppText';
import { styles } from '../screens/ChatScreen.styles';
import { colors } from '../theme/colors';

// Display only: the caller owns the draft, native ref and send/stop decision.
export const ChatTextInput = forwardRef<TextInput, TextInputProps>(function ChatTextInput(props, ref) {
  return <AppTextInput multiline placeholderTextColor={colors.muted} style={styles.input} {...props} ref={ref} />;
});

type ActionProps = Pick<PressableProps, 'accessibilityLabel' | 'onTouchStart' | 'onPressIn' | 'onPress' | 'testID'> & {
  stops: boolean;
  disabled: boolean;
};

export function ChatTextAction({ stops, disabled, ...props }: ActionProps) {
  return (
    <Pressable
      {...props}
      disabled={disabled}
      style={({ pressed }) => [
        styles.sendButton,
        stops && styles.stopButton,
        disabled && styles.sendButtonDisabled,
        pressed && styles.sendButtonPressed,
      ]}
    >
      <Text style={[styles.sendText, stops ? styles.stopText : null]}>{stops ? '■' : '➤'}</Text>
    </Pressable>
  );
}

export function ChatTypingContent({ children }: { children: ReactNode }) {
  return (
    <>
      <ActivityIndicator color="#76A8D2" size="small" />
      <Text style={styles.typingText}>{children}</Text>
    </>
  );
}
