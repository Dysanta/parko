import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, View, type StyleProp, type ViewStyle } from 'react-native';

export type KeyboardViewportProps = { children: ReactNode; style?: StyleProp<ViewStyle>; modal?: boolean };

export function KeyboardViewport({ children, style }: KeyboardViewportProps) {
  if (Platform.OS === 'ios') {
    return <KeyboardAvoidingView behavior="padding" style={style}>{children}</KeyboardAvoidingView>;
  }
  return <View style={style}>{children}</View>;
}
