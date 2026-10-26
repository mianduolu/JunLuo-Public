import { useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';

import {
  createAndroidSyncObjectManagementController,
  type AndroidManagedObjectItem,
  type AndroidObjectManagementSnapshot,
} from '../sync';
import { AppText as Text } from './AppText';

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatSize(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statusLabel(item: AndroidManagedObjectItem) {
  if (item.status === 'pending-upload') return '等待上传';
  if (item.status === 'uploading') {
    return `正在上传 ${item.completedChunks}/${item.totalChunks} 块`;
  }
  if (item.status === 'upload-failed') {
    return '上传失败，可在下一次同步安全重试';
  }
  if (item.status === 'source-missing') {
    return '原文件已不在这台设备；相关记录仍会保留。';
  }
  if (item.status === 'awaiting-confirmation') return '等你确认下载';
  if (item.status === 'downloading') {
    return `正在下载 ${item.completedChunks}/${item.totalChunks} 块`;
  }
  if (item.status === 'local') return '已保存在本机';
  if (item.status === 'evicted') return '本机副本已腾出';
  return '下载失败，可以安全重试';
}

type ManagedObjectGroup = {
  category: string;
  items: Array<{ item: AndroidManagedObjectItem; index: number }>;
  totalSizeBytes: number;
};

function groupManagedObjects(items: AndroidManagedObjectItem[]) {
  const groups = new Map<string, ManagedObjectGroup>();
  items.forEach((item, index) => {
    const existing = groups.get(item.category);
    if (existing) {
      existing.items.push({ item, index });
      existing.totalSizeBytes += item.sizeBytes;
      return;
    }
    groups.set(item.category, {
      category: item.category,
      items: [{ item, index }],
      totalSizeBytes: item.sizeBytes,
    });
  });
  return [...groups.values()];
}

function SmallAction({
  disabled,
  label,
  onPress,
}: {
  disabled: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        disabled && styles.actionDisabled,
        pressed && !disabled && styles.actionPressed,
      ]}
    >
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}

export function SyncObjectManagementCard({
  baseUrl,
  disabled,
  liveRefresh,
  refreshToken,
}: {
  baseUrl: string;
  disabled: boolean;
  liveRefresh: boolean;
  refreshToken: number;
}) {
  const controller = useMemo(
    () => createAndroidSyncObjectManagementController({ baseUrl }),
    [baseUrl],
  );
  const [snapshot, setSnapshot] =
    useState<AndroidObjectManagementSnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    () => new Set(),
  );

  const groups = useMemo(
    () => groupManagedObjects(snapshot?.items ?? []),
    [snapshot?.items],
  );

  useEffect(() => {
    let active = true;
    let refreshing = false;
    const refresh = () => {
      if (refreshing) return;
      refreshing = true;
      setError(null);
      void controller.snapshot()
        .then((value) => {
          if (active) setSnapshot(value);
        })
        .catch((caught) => {
          if (active) setError(errorMessage(caught));
        })
        .finally(() => {
          refreshing = false;
        });
    };
    refresh();
    const interval = liveRefresh
      ? setInterval(refresh, 2_000)
      : undefined;
    return () => {
      active = false;
      if (interval) clearInterval(interval);
    };
  }, [controller, liveRefresh, refreshToken]);

  const run = async (
    key: string,
    operation: () => Promise<AndroidObjectManagementSnapshot>,
  ) => {
    setBusy(key);
    setError(null);
    try {
      setSnapshot(await operation());
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const toggleCategory = (category: string) => {
    setExpandedCategories((current) => {
      const next = new Set(current);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };

  return (
    <View style={styles.card}>
      <Text style={styles.eyebrow}>LOCAL FILES</Text>
      <Text style={styles.title}>这台设备上的文件</Text>
      <Text style={styles.description}>
        这里管理已经来到这台设备、或正在等你确认下载的图片、字体、贴纸和其他文件。打开本页只读本机状态，不会联网或下载。
      </Text>
      <View style={styles.ruleBox}>
        <Text style={styles.ruleText}>
          8 MB 以内自动下载；8–100 MB 只在 Wi‑Fi 下自动；超过 100 MB 会先等你确认。
        </Text>
      </View>

      {groups.map((group) => {
        const expanded = expandedCategories.has(group.category);
        return (
          <View key={group.category} style={styles.group}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              onPress={() => toggleCategory(group.category)}
              style={({ pressed }) => [
                styles.groupToggle,
                pressed && styles.groupTogglePressed,
              ]}
            >
              <Svg
                width={30}
                height={28}
                viewBox="0 0 34 26"
                preserveAspectRatio="none"
                accessibilityElementsHidden
              >
                <Path
                  d="M2.5 4h9.5l2.7 3.5H31v13a2 2 0 0 1-2 2H4.5a2 2 0 0 1-2-2V4Z"
                  fill="#DEF5EF"
                  stroke="#3F8F84"
                  strokeWidth={1.4}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </Svg>
              <View style={styles.groupCopy}>
                <Text style={styles.groupTitle}>{group.category}</Text>
                <Text style={styles.groupSummary}>
                  {group.items.length} 个文件 · 合计 {formatSize(group.totalSizeBytes)}
                </Text>
              </View>
              <View style={styles.groupAction}>
                <Text style={styles.groupActionText}>
                  {expanded ? '收起' : '展开'}
                </Text>
                <Text style={[
                  styles.groupChevron,
                  expanded && styles.groupChevronExpanded,
                ]}>
                  ⌄
                </Text>
              </View>
            </Pressable>

            {expanded && (
              <View style={styles.groupItems}>
                {group.items.map(({ item, index }, groupIndex) => (
                  <View key={`${group.category}:${index}`} style={styles.item}>
                    <View style={[
                      styles.statusDot,
                      item.status === 'local' && styles.statusDotReady,
                      (item.status === 'failed'
                        || item.status === 'upload-failed'
                        || item.status === 'source-missing')
                        && styles.statusDotError,
                    ]} />
                    <View style={styles.itemCopy}>
                      <Text style={styles.itemTitle}>
                        文件 {groupIndex + 1} · {formatSize(item.sizeBytes)}
                      </Text>
                      <Text style={styles.itemStatus}>{statusLabel(item)}</Text>
                    </View>
                    <View style={styles.actions}>
                      {item.actions.canDownload && (
                        <SmallAction
                          disabled={disabled || busy !== null}
                          label="下载到这台设备"
                          onPress={() => void run(
                            `download:${index}`,
                            () => controller.download(item.objectId),
                          )}
                        />
                      )}
                      {item.actions.canPin && (
                        <SmallAction
                          disabled={disabled || busy !== null}
                          label="始终保存在这台设备"
                          onPress={() => void run(
                            `pin:${index}`,
                            () => controller.pin(item.objectId),
                          )}
                        />
                      )}
                      {item.actions.canUnpin && (
                        <SmallAction
                          disabled={disabled || busy !== null}
                          label="不再始终保留"
                          onPress={() => void run(
                            `unpin:${index}`,
                            () => controller.unpin(item.objectId),
                          )}
                        />
                      )}
                      {item.actions.canEvict && (
                        <SmallAction
                          disabled={disabled || busy !== null}
                          label="腾出本机空间"
                          onPress={() => void run(
                            `evict:${index}`,
                            () => controller.evict(item.objectId),
                          )}
                        />
                      )}
                      {item.actions.canRedownload && (
                        <SmallAction
                          disabled={disabled || busy !== null}
                          label="重新下载"
                          onPress={() => void run(
                            `redownload:${index}`,
                            () => controller.download(item.objectId),
                          )}
                        />
                      )}
                    </View>
                  </View>
                ))}
              </View>
            )}
          </View>
        );
      })}

      {error && (
        <View accessibilityLiveRegion="polite" style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    overflow: 'hidden',
    padding: 22,
    borderWidth: 1,
    borderColor: '#D9E9E7',
    borderRadius: 28,
    backgroundColor: '#FFFFFF',
    shadowColor: '#5B7D79',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
  },
  eyebrow: {
    color: '#6D9793',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 2.1,
  },
  title: {
    marginTop: 8,
    color: '#344D5E',
    fontSize: 23,
    fontWeight: '800',
  },
  description: {
    marginTop: 10,
    color: '#687C85',
    fontSize: 14,
    lineHeight: 23,
  },
  ruleBox: {
    marginTop: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: '#F0DCA8',
    borderRadius: 16,
    backgroundColor: '#FFF8DD',
  },
  ruleText: {
    color: '#8D784C',
    fontSize: 13,
    lineHeight: 20,
  },
  group: {
    overflow: 'hidden',
    marginTop: 12,
    borderWidth: 1,
    borderColor: '#DCEAE8',
    borderRadius: 19,
    backgroundColor: '#F9FCFC',
  },
  groupToggle: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: '#F0FAF7',
  },
  groupTogglePressed: {
    backgroundColor: '#E3F5F0',
  },
  groupCopy: {
    flex: 1,
    minWidth: 0,
  },
  groupTitle: {
    color: '#3F5968',
    fontSize: 16,
    fontWeight: '700',
  },
  groupSummary: {
    marginTop: 4,
    color: '#789096',
    fontSize: 13,
  },
  groupAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  groupActionText: {
    color: '#4E887D',
    fontSize: 14,
    fontWeight: '700',
  },
  groupChevron: {
    color: '#4E887D',
    fontSize: 20,
    lineHeight: 20,
    transform: [{ rotate: '0deg' }],
  },
  groupChevronExpanded: {
    transform: [{ rotate: '180deg' }],
  },
  groupItems: {
    gap: 8,
    padding: 9,
    borderTopWidth: 1,
    borderTopColor: '#DCEAE8',
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    padding: 13,
    borderWidth: 1,
    borderColor: '#DFECEB',
    borderRadius: 18,
    backgroundColor: '#FFFFFF',
  },
  statusDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: '#E5B64A',
  },
  statusDotReady: {
    backgroundColor: '#62B59F',
  },
  statusDotError: {
    backgroundColor: '#D97C7C',
  },
  itemCopy: {
    flex: 1,
    minWidth: 0,
  },
  itemTitle: {
    color: '#3F5968',
    fontSize: 14,
    fontWeight: '700',
  },
  itemStatus: {
    marginTop: 4,
    color: '#849399',
    fontSize: 12,
  },
  actions: {
    alignItems: 'flex-end',
    gap: 6,
  },
  action: {
    minHeight: 34,
    justifyContent: 'center',
    paddingHorizontal: 11,
    borderWidth: 1,
    borderColor: '#CDE4DF',
    borderRadius: 12,
    backgroundColor: '#EAF8F4',
  },
  actionDisabled: {
    opacity: 0.45,
  },
  actionPressed: {
    transform: [{ scale: 0.98 }],
  },
  actionText: {
    color: '#4E887D',
    fontSize: 12,
    fontWeight: '700',
  },
  errorBox: {
    marginTop: 12,
    padding: 12,
    borderRadius: 14,
    backgroundColor: '#FFF0EC',
  },
  errorText: {
    color: '#A45C55',
    fontSize: 12,
    lineHeight: 19,
  },
});
