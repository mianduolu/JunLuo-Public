import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { useAiConfigPreferences } from '../ai/AiConfigPreferences';
import { useBackgroundPreferences } from '../backgrounds/BackgroundPreferences';
import { checkCameraPermission } from '../camera/cameraPermission';
import { useCameraPerceptionRuntime } from '../camera/cameraPerceptionRuntime';
import { AppText as Text } from '../components/AppText';
import { fontOptions } from '../fonts/fontCatalog';
import { useFontPreferences } from '../fonts/FontPreferences';
import { loadNearbyWorldSnapshot } from '../nearby/nearbyWorldStore';
import { loadCurrentSyncDevice } from '../sync/syncCurrentDevice';
import { colors } from '../theme/colors';
import { listToolPackages, registerBuiltinTools } from '../tools';
import type { Navigate, ScreenName } from '../types/navigation';
import { aiSettingsSections } from './aiSettingsSections';

type Props = {
  navigate: Navigate;
};

type EntryProps = {
  compact?: boolean;
  accent: string;
  description: string;
  label: string;
  meta: string;
  onPress: () => void;
};

function SettingsEntry({ accent, description, label, meta, onPress, compact = false }: EntryProps) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.entry, compact && styles.compactEntry, pressed && styles.entryPressed]}>
      <View style={[styles.entryAccent, { backgroundColor: accent }]} />
      <View style={styles.entryCopy}>
        <Text style={styles.entryTitle}>{label}</Text>
        <Text style={[styles.entryDescription, compact && styles.compactDescription]}>{description}</Text>
      </View>
      <View style={styles.entryEnd}>
        {meta ? <Text numberOfLines={1} style={styles.entryMeta}>{meta}</Text> : null}
        <Text style={styles.entryArrow}>›</Text>
      </View>
    </Pressable>
  );
}

function SectionTitle({ children }: { children: string }) {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

export function SettingsScreen({ navigate }: Props) {
  const cameraRuntime = useCameraPerceptionRuntime();
  const { chatConnection, chatKey } = useAiConfigPreferences();
  const { choice: fontChoice } = useFontPreferences();
  const { settings: background } = useBackgroundPreferences();
  const [nearbyMeta, setNearbyMeta] = useState('未开启');
  const [cameraMeta, setCameraMeta] = useState('未授权');
  const [toolMeta, setToolMeta] = useState('待查看');
  const [deviceSyncMeta, setDeviceSyncMeta] = useState('未建立');
  const currentFont = fontOptions.find((option) => option.value === fontChoice)?.label ?? '跟随系统';
  const currentBackground =
    background.mode === 'image' ? '图片背景' : background.mode === 'fixed' ? '固定天空' : '时光天空';
  const connectionReady = !!chatConnection?.baseUrl.trim() && !!chatConnection?.model.trim() && !!chatKey.trim();
  const cameraSessionMeta = cameraRuntime.session.status === 'running'
    ? cameraRuntime.nativeSnapshot?.cameraState === 'previewing' ? '预览中' : '会话待命'
    : cameraRuntime.session.status === 'paused_camera_busy'
      ? '已暂停'
      : cameraRuntime.session.status === 'starting'
        ? '启动中'
        : cameraRuntime.session.status === 'stopping'
          ? '停止中'
          : cameraRuntime.session.status === 'error'
            ? '会话错误'
            : cameraMeta;
  const open = (screen: ScreenName) => () => navigate(screen);

  useEffect(() => {
    let mounted = true;
    void loadNearbyWorldSnapshot()
      .then(({ settings, status }) => {
        if (!mounted) return;
        if (!settings.enabled) {
          setNearbyMeta('未开启');
        } else if (!settings.amapKey.trim()) {
          setNearbyMeta('缺高德 Key');
        } else if (status.updatedAt) {
          setNearbyMeta(status.presence === 'at_home' ? '在家附近' : status.presence === 'outside' ? '在外面' : '已开启');
        } else {
          setNearbyMeta('待刷新');
        }
      })
      .catch(() => {
        if (mounted) setNearbyMeta('未开启');
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    void checkCameraPermission().then((status) => {
      if (!mounted) return;
      setCameraMeta(status === 'granted' ? '已授权' : status === 'blocked' ? '需到系统设置' : '未授权');
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    try {
      registerBuiltinTools();
      setToolMeta(`${listToolPackages().length} 个包`);
    } catch {
      setToolMeta('待查看');
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    void loadCurrentSyncDevice()
      .then((current) => {
        if (mounted) setDeviceSyncMeta(current ? '手机已启用' : '未建立');
      })
      .catch(() => {
        if (mounted) setDeviceSyncMeta('待检查');
      });
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Pressable accessibilityLabel="返回首页" onPress={() => navigate('home')} style={styles.backButton}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text style={styles.title}>设置</Text>
        <View style={styles.headerSpacer} />
      </View>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <SectionTitle>白云与连接</SectionTitle>
        <View style={styles.section}>
          {aiSettingsSections.map(section => (
            <SettingsEntry
              compact
              key={section.route}
              accent={section.accent}
              description={section.description}
              label={section.title}
              meta={section.route === 'ai-settings' ? (connectionReady ? '已连接' : '待连接') : ''}
              onPress={open(section.route)}
            />
          ))}
          <SettingsEntry
            accent="#A5C8FF"
            description="音色、密钥、预算和测试来电"
            label="白云小姐语音通话"
            meta="配置"
            onPress={open('voice-call-settings')}
          />
          <SettingsEntry
            accent="#A8D9B4"
            description="白云小姐自己写下、还没发布的公开草稿"
            label="君落草稿箱"
            meta="待看看"
            onPress={open('social-drafts')}
          />
        </View>

        <SectionTitle>感知与生活</SectionTitle>
        <View style={styles.section}>
          <SettingsEntry
            accent="#88CBE0"
            description="位置、天气和附近地点的小小现实感"
            label="附近世界"
            meta={nearbyMeta}
            onPress={open('nearby-world')}
          />
          <SettingsEntry
            accent="#F2A6BC"
            description="摄像头授权、稀疏观察节奏和镜头偏好"
            label="白云的视线"
            meta={cameraSessionMeta}
            onPress={open('camera-perception')}
          />
          <SettingsEntry
            accent="#7A9F79"
            description="扫描戒指，把身体信号接进君落"
            label="身体感知"
            meta="R02"
            onPress={open('body-signal')}
          />
        </View>

        <SectionTitle>外观与工具</SectionTitle>
        <View style={styles.section}>
          <SettingsEntry
            accent="#9FCDF5"
            description="背景、字体与天气动画开关"
            label="外观衣柜"
            meta={`${currentBackground} · ${currentFont}`}
            onPress={open('appearance')}
          />
          <SettingsEntry
            accent="#BBA8F2"
            description="查看白云能调用的工具、权限和最近回执"
            label="工具包与权限"
            meta={toolMeta}
            onPress={open('tool-settings')}
          />
        </View>

        <SectionTitle>资料与设备</SectionTitle>
        <View style={styles.section}>
          <SettingsEntry
            accent="#F4B59E"
            description="单独检查和分批整理重复记忆，不加载整本记忆列表"
            label="清理重复记忆"
            meta="分批清理"
            onPress={open('memory-maintenance')}
          />
          <SettingsEntry
            accent="#72B8AE"
            description="添加电脑、同步数据和处理设备问题"
            label="设备与同步"
            meta={deviceSyncMeta}
            onPress={open('device-sync')}
          />
          <SettingsEntry
            accent="#AEE1D6"
            description="保存和恢复手机里的生活资料"
            label="手机备份"
            meta="本机"
            onPress={open('backup')}
          />
          <SettingsEntry
            accent="#6FB7A7"
            description="手动导出或导入加密的服务凭据"
            label="君落秘密包"
            meta="本机"
            onPress={open('secret-package')}
          />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    paddingTop: 18,
    paddingHorizontal: 18,
    backgroundColor: '#F7FBFA',
  },
  header: {
    height: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 18,
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#FFE2DA',
  },
  backText: {
    color: colors.ink,
    fontSize: 32,
    lineHeight: 34,
  },
  title: {
    color: colors.ink,
    fontSize: 27,
    fontWeight: '800',
  },
  headerSpacer: {
    width: 44,
    height: 44,
  },
  content: {
    paddingBottom: 32,
  },
  sectionTitle: {
    color: '#668381',
    fontSize: 16,
    fontWeight: '800',
    marginLeft: 7,
    marginBottom: 9,
    marginTop: 8,
  },
  section: {
    marginBottom: 19,
  },
  entry: {
    minHeight: 92,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#DCEBE8',
    paddingVertical: 16,
    paddingLeft: 14,
    paddingRight: 16,
  },
  entryPressed: {
    backgroundColor: '#EEF8F6',
    transform: [{ scale: 0.99 }],
  },
  compactEntry: {
    minHeight: 78,
    paddingVertical: 12,
    marginBottom: 8,
  },
  compactDescription: {
    fontSize: 14,
    lineHeight: 20,
  },
  entryAccent: {
    width: 9,
    height: 48,
    borderRadius: 5,
    marginRight: 13,
  },
  entryCopy: {
    flex: 1,
    minWidth: 0,
  },
  entryTitle: {
    color: colors.ink,
    fontSize: 19,
    fontWeight: '800',
    marginBottom: 4,
  },
  entryDescription: {
    color: colors.muted,
    fontSize: 16,
    lineHeight: 23,
  },
  entryEnd: {
    maxWidth: 118,
    marginLeft: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  entryMeta: {
    flexShrink: 1,
    color: '#9C7D76',
    fontSize: 15,
  },
  entryArrow: {
    color: '#D28F83',
    fontSize: 26,
    lineHeight: 28,
  },
});
