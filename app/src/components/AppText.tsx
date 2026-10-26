import { forwardRef } from 'react';
import { Text, TextInput, type TextInputProps, type TextProps } from 'react-native';

import { useFontPreferences } from '../fonts/FontPreferences';

export function AppText({ style, ...props }: TextProps) {
  const { fontFamily } = useFontPreferences();

  return <Text {...props} style={[style, fontFamily ? { fontFamily, fontWeight: 'normal' } : null]} />;
}

export const AppTextInput = forwardRef<TextInput, TextInputProps>(function AppTextInput({ style, ...props }, ref) {
  const { fontFamily } = useFontPreferences();

  return <TextInput ref={ref} {...props} style={[style, fontFamily ? { fontFamily, fontWeight: 'normal' } : null]} />;
});
