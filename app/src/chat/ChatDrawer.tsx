import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { Pressable, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import type { EdgeInsets } from 'react-native-safe-area-context';
import type { Navigate } from '../types/navigation';
import { AppText as Text } from '../components/AppText';
import { styles } from '../screens/ChatScreen.styles';

export type ChatDrawerHandle = {
  close: () => void;
  isOpen: () => boolean;
  open: () => void;
};

export type ChatDrawerProps = {
  insets: EdgeInsets;
  navigate: Navigate;
  onSearchHistory: () => void;
};

export const ChatDrawer = memo(forwardRef<ChatDrawerHandle, ChatDrawerProps>(function ChatDrawer(
  {
    insets,
    navigate,
    onSearchHistory,
  },
  ref,
) {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const drawerProgress = useSharedValue(0);

  const closeDrawer = () => {
    openRef.current = false;
    setOpen(false);
  };

  const openDrawer = () => {
    openRef.current = true;
    setOpen(true);
  };

  useImperativeHandle(ref, () => ({
    close: closeDrawer,
    isOpen: () => openRef.current,
    open: openDrawer,
  }));

  useEffect(() => {
    drawerProgress.value = withTiming(open ? 1 : 0, { duration: open ? 170 : 130 });
  }, [drawerProgress, open]);

  const drawerLayerAnimatedStyle = useAnimatedStyle(() => ({
    opacity: drawerProgress.value,
  }));
  const drawerPanelAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -420 * (1 - drawerProgress.value) }],
  }));

  const closeAndNavigate = (target: Parameters<Navigate>[0]) => {
    closeDrawer();
    navigate(target);
  };

  return (
    <Animated.View pointerEvents={open ? 'auto' : 'none'} style={[styles.drawerLayer, drawerLayerAnimatedStyle]}>
      <Pressable accessibilityLabel="关闭功能栏" onPress={closeDrawer} style={styles.drawerScrim} />
      <Animated.View
        style={[
          styles.drawerPanel,
          drawerPanelAnimatedStyle,
          {
            paddingBottom: Math.max(insets.bottom + 18, 32),
            paddingTop: Math.max(insets.top, 24),
          },
        ]}
      >
        <View style={styles.drawerActions}>
          <Pressable onPress={() => { closeDrawer(); onSearchHistory(); }} style={styles.newChatButton}>
            <Text style={styles.newChatText}>搜索聊天记录</Text>
          </Pressable>
          <Pressable
            accessibilityLabel="白云与连接"
            onPress={() => closeAndNavigate('ai-settings')}
            style={styles.drawerIconButton}
          >
            <Text style={styles.drawerIconText}>设</Text>
          </Pressable>
        </View>
        <Text style={styles.drawerHeading}>功能</Text>
        <View style={styles.sessionScroll}>
          <Pressable onPress={() => closeAndNavigate('memory-current-states')} style={styles.drawerFooterButton}>
            <Text style={styles.drawerFooterText}>近况</Text>
          </Pressable>
          <Pressable onPress={() => closeAndNavigate('memory-understandings')} style={[styles.drawerFooterButton, { marginTop: 9 }]}>
            <Text style={styles.drawerFooterText}>认识</Text>
          </Pressable>
        </View>
        <View style={styles.drawerFooter}>
          <Pressable
            onPress={() => closeAndNavigate('period')}
            style={({ pressed }) => [styles.drawerFooterButton, pressed ? styles.drawerFooterButtonPressed : null]}
          >
            {({ pressed }) => <Text style={[styles.drawerFooterText, pressed ? styles.drawerFooterTextPressed : null]}>☾  与你</Text>}
          </Pressable>
          <Pressable
            onPress={() => closeAndNavigate('schedule')}
            style={({ pressed }) => [styles.drawerFooterButton, pressed ? styles.drawerFooterButtonPressed : null]}
          >
            {({ pressed }) => <Text style={[styles.drawerFooterText, pressed ? styles.drawerFooterTextPressed : null]}>▦  日程</Text>}
          </Pressable>
          <Pressable
            onPress={() => closeAndNavigate('favorites')}
            style={({ pressed }) => [styles.drawerFooterButton, pressed ? styles.drawerFooterButtonPressed : null]}
          >
            {({ pressed }) => <Text style={[styles.drawerFooterText, pressed ? styles.drawerFooterTextPressed : null]}>♡  爱心语料</Text>}
          </Pressable>
          <Pressable
            onPress={() => closeAndNavigate('memory')}
            style={({ pressed }) => [styles.drawerFooterButton, pressed ? styles.drawerFooterButtonPressed : null]}
          >
            {({ pressed }) => <Text style={[styles.drawerFooterText, pressed ? styles.drawerFooterTextPressed : null]}>◇  记忆本</Text>}
          </Pressable>
          <Pressable
            onPress={() => closeAndNavigate('home')}
            style={({ pressed }) => [styles.drawerFooterButton, pressed ? styles.drawerFooterButtonPressed : null]}
          >
            {({ pressed }) => <Text style={[styles.drawerFooterText, pressed ? styles.drawerFooterTextPressed : null]}>⌂  返回主页</Text>}
          </Pressable>
        </View>
      </Animated.View>
    </Animated.View>
  );
}));
