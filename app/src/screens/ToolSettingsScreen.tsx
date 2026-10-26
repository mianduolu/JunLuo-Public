import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import {
  loadBackendSettings,
  saveBackendSettings,
  searchLifeResearchWithDiagnostics,
  type LifeResearchSearchResponse,
} from '../backend/backendClient';
import { AppText as Text } from '../components/AppText';
import { colors } from '../theme/colors';
import {
  describeManualSearchNotice,
  diagnosticFacts,
  diagnosticStatusLabel,
  groupSearchDiagnostics,
} from './toolSettingsDiagnostics';
import {
  clearPackageToolPermissionOverride,
  clearTemporaryToolPermissionGrantsForTarget,
  clearToolPermissionOverride,
  deleteGithubToken,
  grantPackageToolPermissionForSession,
  grantPackageToolPermissionUntilEndOfDay,
  grantToolPermissionForSession,
  grantToolPermissionUntilEndOfDay,
  loadActiveToolPermissionGrants,
  loadGithubConfigStatus,
  listMcpServerStatuses,
  addMcpServerConfig,
  removeMcpServerConfig,
  setMcpServerToken,
  executeToolCall,
  listToolPackages,
  listTools,
  loadToolPermissionSettings,
  registerBuiltinTools,
  saveGithubSettings,
  saveGithubToken,
  setGlobalToolPermission,
  setPackageToolPermission,
  setToolPermissionOverride,
  type JunLuoGithubConfigStatus,
  type JunLuoMcpServerStatus,
  type JunLuoToolDefinition,
  type JunLuoToolPackage,
  type JunLuoToolTemporaryPermissionGrant,
  type JunLuoToolPermissionLevel,
  type JunLuoToolPermissionSettings,
} from '../tools';
import type { Navigate } from '../types/navigation';

type Props = {
  navigate: Navigate;
};

type PermissionChoice = JunLuoToolPermissionLevel | 'inherit';
type PackageFilter = 'all' | 'read_only' | 'action' | 'dangerous' | 'external' | 'disabled';

type ToolSettingsSnapshot = {
  activeGrants: JunLuoToolTemporaryPermissionGrant[];
  packages: JunLuoToolPackage[];
  permissions: JunLuoToolPermissionSettings;
  tools: JunLuoToolDefinition[];
};

const PERMISSION_CHOICES: Array<{ label: string; value: PermissionChoice }> = [
  { label: '跟随', value: 'inherit' },
  { label: '允许', value: 'allow' },
  { label: '询问', value: 'ask' },
  { label: '拒绝', value: 'deny' },
];

const GLOBAL_PERMISSION_CHOICES: Array<{ label: string; value: JunLuoToolPermissionLevel }> = [
  { label: '允许', value: 'allow' },
  { label: '询问', value: 'ask' },
  { label: '拒绝', value: 'deny' },
];

const PACKAGE_FILTER_CHOICES: Array<{ label: string; value: PackageFilter }> = [
  { label: '全部', value: 'all' },
  { label: '只读', value: 'read_only' },
  { label: '会执行动作', value: 'action' },
  { label: '危险', value: 'dangerous' },
  { label: '外部/MCP', value: 'external' },
  { label: '默认禁用', value: 'disabled' },
];

function permissionLabel(permission: JunLuoToolPermissionLevel | undefined) {
  if (permission === 'allow') return '允许';
  if (permission === 'deny') return '拒绝';
  if (permission === 'ask') return '询问';
  return '跟随';
}

function riskLabel(risk: string) {
  const labels: Record<string, string> = {
    dangerous: '危险',
    device_control: '设备',
    external_network: '网络',
    read: '只读',
    social_action: '社交',
    write_local: '本地写入',
  };
  return labels[risk] ?? risk;
}

function temporaryGrantLabel(grant?: JunLuoToolTemporaryPermissionGrant) {
  if (!grant) return '无临时授权';
  const duration = grant.duration === 'today' ? '今日' : '本轮';
  return `${duration}${permissionLabel(grant.permission)}`;
}

function packageMatchesFilter(toolPackage: JunLuoToolPackage, packageTools: JunLuoToolDefinition[], filter: PackageFilter) {
  if (filter === 'all') return true;
  if (filter === 'read_only') return packageTools.length > 0 && packageTools.every((tool) => tool.readOnly);
  if (filter === 'action') return packageTools.some((tool) => !tool.readOnly);
  if (filter === 'dangerous') return toolPackage.riskLevel === 'dangerous' || packageTools.some((tool) => tool.riskLevel === 'dangerous');
  if (filter === 'external') return toolPackage.source !== 'builtin' || toolPackage.id === 'mcp_admin';
  if (filter === 'disabled') return !toolPackage.defaultEnabled;
  return true;
}

function formatTime(value?: number) {
  if (!value) return '未知时间';
  const date = new Date(value);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  const hour = `${date.getHours()}`.padStart(2, '0');
  const minute = `${date.getMinutes()}`.padStart(2, '0');
  return `${month}-${day} ${hour}:${minute}`;
}

function PermissionSegment<T extends string>({
  choices,
  value,
  onChange,
}: {
  choices: Array<{ label: string; value: T }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.segment}>
      {choices.map((choice) => {
        const selected = choice.value === value;
        return (
          <Pressable
            key={choice.value}
            onPress={() => onChange(choice.value)}
            style={({ pressed }) => [
              styles.segmentButton,
              selected && styles.segmentButtonSelected,
              pressed && styles.segmentButtonPressed,
            ]}
          >
            <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>{choice.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function ToolSettingsScreen({ navigate }: Props) {
  const [backendBaseUrl, setBackendBaseUrl] = useState('');
  const [backendNotice, setBackendNotice] = useState('');
  const [snapshot, setSnapshot] = useState<ToolSettingsSnapshot | null>(null);
  const [loadingLabel, setLoadingLabel] = useState('正在整理工具包');
  const [manualSearchBusy, setManualSearchBusy] = useState(false);
  const [manualSearchError, setManualSearchError] = useState('');
  const [manualSearchQuery, setManualSearchQuery] = useState('猫为什么踩奶');
  const [manualSearchResponse, setManualSearchResponse] = useState<LifeResearchSearchResponse | null>(null);
  const [githubApiBaseUrl, setGithubApiBaseUrl] = useState('https://api.github.com');
  const [githubConfigStatus, setGithubConfigStatus] = useState<JunLuoGithubConfigStatus | null>(null);
  const [githubCredentialNotice, setGithubCredentialNotice] = useState('');
  const [githubTokenInput, setGithubTokenInput] = useState('');
  const [mcpEndpointInput, setMcpEndpointInput] = useState('');
  const [mcpNameInput, setMcpNameInput] = useState('');
  const [mcpNotice, setMcpNotice] = useState('');
  const [mcpServers, setMcpServers] = useState<JunLuoMcpServerStatus[]>([]);
  const [mcpSyncingId, setMcpSyncingId] = useState('');
  const [mcpTokenInputById, setMcpTokenInputById] = useState<Record<string, string>>({});
  const [packageFilter, setPackageFilter] = useState<PackageFilter>('all');

  const refreshMcpServers = useCallback(() => {
    void listMcpServerStatuses()
      .then(setMcpServers)
      .catch(() => setMcpNotice('MCP server 状态读取失败。'));
  }, []);

  const refreshGithubConfigStatus = useCallback(() => {
    void loadGithubConfigStatus()
      .then((status) => {
        setGithubConfigStatus(status);
        setGithubApiBaseUrl(status.apiBaseUrl);
      })
      .catch(() => setGithubCredentialNotice('GitHub 配置状态读取失败。'));
  }, []);

  const refresh = useCallback(() => {
    setLoadingLabel('正在整理工具包');
    try {
      registerBuiltinTools();
    } catch {
      // Builtin registration is idempotent; keep the settings page usable if another caller registered first.
    }
    void Promise.all([
      loadToolPermissionSettings(),
      loadActiveToolPermissionGrants(),
    ])
      .then(([permissions, activeGrants]) => {
        const packages = listToolPackages().sort((left, right) => left.id.localeCompare(right.id));
        const tools = listTools().sort((left, right) => left.id.localeCompare(right.id));
        setSnapshot({ activeGrants, packages, permissions, tools });
        setLoadingLabel('');
      })
      .catch(() => setLoadingLabel('工具包信息暂时读取失败'));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    refreshMcpServers();
  }, [refreshMcpServers]);

  useEffect(() => {
    void loadBackendSettings()
      .then((settings) => setBackendBaseUrl(settings.baseUrl))
      .catch(() => undefined);
  }, []);

  const toolsByPackage = useMemo(() => {
    const grouped = new Map<string, JunLuoToolDefinition[]>();
    snapshot?.tools.forEach((tool) => {
      const tools = grouped.get(tool.packageId) ?? [];
      tools.push(tool);
      grouped.set(tool.packageId, tools);
    });
    return grouped;
  }, [snapshot?.tools]);

  const filteredPackages = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.packages.filter((toolPackage) => packageMatchesFilter(toolPackage, toolsByPackage.get(toolPackage.id) ?? [], packageFilter));
  }, [packageFilter, snapshot, toolsByPackage]);

  const updateGlobalPermission = (permission: JunLuoToolPermissionLevel) => {
    void setGlobalToolPermission(permission).then(refresh);
  };

  const updatePackagePermission = (packageId: string, permission: PermissionChoice) => {
    const task = permission === 'inherit'
      ? clearPackageToolPermissionOverride(packageId)
      : setPackageToolPermission(packageId, permission);
    void task.then(refresh);
  };

  const updateToolPermission = (toolId: string, permission: PermissionChoice) => {
    const task = permission === 'inherit'
      ? clearToolPermissionOverride(toolId)
      : setToolPermissionOverride(toolId, permission);
    void task.then(refresh);
  };

  const grantPackageForSession = (packageId: string) => {
    try {
      grantPackageToolPermissionForSession(packageId, 'allow', '设置页本轮预授权');
      refresh();
    } catch {
      setLoadingLabel('临时授权写入失败');
    }
  };

  const grantToolForSession = (toolId: string) => {
    try {
      grantToolPermissionForSession(toolId, 'allow', '设置页本轮预授权');
      refresh();
    } catch {
      setLoadingLabel('临时授权写入失败');
    }
  };

  const grantPackageForToday = (packageId: string) => {
    void grantPackageToolPermissionUntilEndOfDay(packageId, 'allow', '设置页今日预授权').then(refresh);
  };

  const grantToolForToday = (toolId: string) => {
    void grantToolPermissionUntilEndOfDay(toolId, 'allow', '设置页今日预授权').then(refresh);
  };

  const clearTemporaryGrants = (scope: 'package' | 'tool', targetId: string) => {
    void clearTemporaryToolPermissionGrantsForTarget(scope, targetId).then(refresh);
  };

  const runManualSearch = () => {
    const query = manualSearchQuery.trim();
    if (!query || manualSearchBusy) return;
    setManualSearchBusy(true);
    setManualSearchError('');
    const normalizedBaseUrl = backendBaseUrl.trim().replace(/\/+$/, '');
    void saveBackendSettings({ baseUrl: normalizedBaseUrl, enabled: !!normalizedBaseUrl })
      .then(() => {
        setBackendBaseUrl(normalizedBaseUrl);
        setBackendNotice(normalizedBaseUrl ? '正在使用手机端多源优先搜索；必要时才会尝试电脑后端增强。' : '正在使用手机端多源优先搜索。');
        return searchLifeResearchWithDiagnostics(query);
      })
      .then((response) => {
        setManualSearchResponse(response);
        setBackendNotice(describeManualSearchNotice(response, normalizedBaseUrl));
      })
      .catch((error) => {
        setManualSearchResponse(null);
        setManualSearchError(error instanceof Error ? error.message : '搜索请求失败');
      })
      .finally(() => setManualSearchBusy(false));
  };

  const saveGithubCredential = () => {
    const nextBaseUrl = githubApiBaseUrl.trim() || 'https://api.github.com';
    void saveGithubSettings({ apiBaseUrl: nextBaseUrl })
      .then(() => githubTokenInput.trim() ? saveGithubToken(githubTokenInput) : undefined)
      .then(() => {
        setGithubTokenInput('');
        setGithubCredentialNotice(githubTokenInput.trim() ? 'GitHub Token 已保存，页面只会显示脱敏状态。' : 'GitHub API 地址已保存。');
        refreshGithubConfigStatus();
      })
      .catch((error) => setGithubCredentialNotice(error instanceof Error ? error.message : 'GitHub 凭据保存失败。'));
  };

  const deleteGithubCredential = () => {
    void deleteGithubToken()
      .then(() => {
        setGithubTokenInput('');
        setGithubCredentialNotice('GitHub Token 已删除。');
        refreshGithubConfigStatus();
      })
      .catch(() => setGithubCredentialNotice('GitHub Token 删除失败。'));
  };

  const addMcpServer = () => {
    void addMcpServerConfig({ endpoint: mcpEndpointInput, name: mcpNameInput })
      .then((config) => {
        setMcpEndpointInput('');
        setMcpNameInput('');
        setMcpNotice(`已登记 MCP server：${config.name}。如需 token，请在该 server 卡片里保存。`);
        refreshMcpServers();
      })
      .catch((error) => setMcpNotice(error instanceof Error ? error.message : 'MCP server 保存失败。'));
  };

  const saveMcpToken = (serverId: string) => {
    const token = mcpTokenInputById[serverId] ?? '';
    void setMcpServerToken(serverId, token)
      .then(() => {
        setMcpTokenInputById((current) => ({ ...current, [serverId]: '' }));
        setMcpNotice(token.trim() ? 'MCP token 已保存，页面只显示脱敏状态。' : 'MCP token 已清空。');
        refreshMcpServers();
      })
      .catch(() => setMcpNotice('MCP token 保存失败。'));
  };

  const syncMcpServer = (serverId: string) => {
    setMcpSyncingId(serverId);
    void executeToolCall({
      callId: `settings-mcp-sync-${serverId}-${Date.now()}`,
      toolId: 'mcp_admin.sync_server',
      input: { serverId },
      requestedBy: 'manual',
      createdAt: Date.now(),
    })
      .then((result) => {
        setMcpNotice(result.summary);
        refreshMcpServers();
        refresh();
      })
      .catch((error) => setMcpNotice(error instanceof Error ? error.message : 'MCP server 同步失败。'))
      .finally(() => setMcpSyncingId(''));
  };

  const removeMcpServer = (serverId: string) => {
    void removeMcpServerConfig(serverId)
      .then(() => {
        setMcpNotice(`已移除 MCP server：${serverId}`);
        refreshMcpServers();
        refresh();
      })
      .catch(() => setMcpNotice('MCP server 删除失败。'));
  };

  const saveBackendBaseUrl = () => {
    const normalizedBaseUrl = backendBaseUrl.trim().replace(/\/+$/, '');
    void saveBackendSettings({ baseUrl: normalizedBaseUrl, enabled: !!normalizedBaseUrl })
      .then(() => {
        setBackendBaseUrl(normalizedBaseUrl);
        setBackendNotice(normalizedBaseUrl ? `已保存：${normalizedBaseUrl}` : '已清空电脑后端地址。');
      })
      .catch(() => setBackendNotice('后端地址保存失败。'));
  };

  const packageCount = snapshot?.packages.length ?? 0;
  const toolCount = snapshot?.tools.length ?? 0;
  const grantCount = snapshot?.activeGrants.length ?? 0;

  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Pressable accessibilityLabel="返回设置" onPress={() => navigate('settings')} style={styles.backButton}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text style={styles.title}>工具包与权限</Text>
        <Pressable onPress={refresh} style={styles.refreshButton}>
          <Text style={styles.refreshText}>刷新</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {loadingLabel ? <Text style={styles.loadingText}>{loadingLabel}</Text> : null}

        {snapshot ? (
          <>
            <View style={styles.summaryGrid}>
              <SummaryCard label="工具包" value={`${packageCount}`} />
              <SummaryCard label="工具" value={`${toolCount}`} />
              <SummaryCard label="默认权限" value={permissionLabel(snapshot.permissions.globalDefault)} />
              <SummaryCard label="临时授权" value={`${grantCount}`} />
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>第二轮收口筛选</Text>
              <Text style={styles.cardDescription}>这些筛选只改变本页显示，方便鼠快速看见默认禁用、危险、外部 MCP 和会执行动作的工具包。</Text>
              <PermissionSegment choices={PACKAGE_FILTER_CHOICES} value={packageFilter} onChange={setPackageFilter} />
              <Text style={styles.fieldHint}>当前显示 {filteredPackages.length}/{packageCount} 个工具包；没有隐藏或禁用真实工具。</Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>手动网页搜索测试</Text>
              <Text style={styles.cardDescription}>直接调用公开网页搜索链路，不等待白云小姐自主触发，也不走远游冷却；当前手机端多源优先，电脑后端只是增强路径。</Text>
              <Text style={styles.fieldLabel}>电脑后端地址</Text>
              <View style={styles.searchInputRow}>
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={setBackendBaseUrl}
                  onSubmitEditing={saveBackendBaseUrl}
                  placeholder="填写自己的电脑后端地址"
                  placeholderTextColor="#B9A6A0"
                  returnKeyType="done"
                  style={styles.searchInput}
                  value={backendBaseUrl}
                />
                <Pressable
                  onPress={saveBackendBaseUrl}
                  style={({ pressed }) => [
                    styles.saveBackendButton,
                    pressed && styles.saveBackendButtonPressed,
                  ]}
                >
                  <Text style={styles.saveBackendButtonText}>保存</Text>
                </Pressable>
              </View>
              <Text style={styles.fieldHint}>
                手机端会先尝试多源搜索；需要后端增强时再填写电脑地址，真手机不能用 127.0.0.1 连接电脑。
              </Text>
              {backendNotice ? <Text style={styles.backendNotice}>{backendNotice}</Text> : null}
              <Text style={styles.fieldLabel}>搜索词</Text>
              <View style={styles.searchInputRow}>
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={setManualSearchQuery}
                  onSubmitEditing={runManualSearch}
                  placeholder="输入搜索词"
                  placeholderTextColor="#B9A6A0"
                  returnKeyType="search"
                  style={styles.searchInput}
                  value={manualSearchQuery}
                />
                <Pressable
                  disabled={manualSearchBusy || !manualSearchQuery.trim()}
                  onPress={runManualSearch}
                  style={({ pressed }) => [
                    styles.searchButton,
                    pressed && styles.searchButtonPressed,
                    (manualSearchBusy || !manualSearchQuery.trim()) && styles.searchButtonDisabled,
                  ]}
                >
                  <Text style={styles.searchButtonText}>{manualSearchBusy ? '搜索中' : '测试'}</Text>
                </Pressable>
              </View>
              {manualSearchError ? <Text style={styles.auditError}>{manualSearchError}</Text> : null}
              {manualSearchResponse ? (
                <View style={styles.searchResultBlock}>
                  <Text style={styles.searchResultTitle}>结果 {manualSearchResponse.results.length} 条</Text>
                  {manualSearchResponse.diagnostics.length ? (
                    <View style={styles.diagnosticList}>
                      {groupSearchDiagnostics(manualSearchResponse.diagnostics).map((group) => (
                        <View key={group.key} style={styles.diagnosticGroup}>
                          <Text style={styles.diagnosticGroupTitle}>{group.label} {group.diagnostics.length} 条</Text>
                          {group.diagnostics.map((diagnostic) => {
                            const facts = diagnosticFacts(diagnostic);
                            return (
                              <View key={diagnostic.id} style={styles.diagnosticRow}>
                                <Text style={styles.diagnosticName}>{diagnostic.label}</Text>
                                <Text style={styles.diagnosticMeta}>
                                  {diagnosticStatusLabel(diagnostic.status)}
                                  {facts.length ? ` · ${facts.join(' · ')}` : ''}
                                </Text>
                                {diagnostic.lastFailure ? <Text style={styles.diagnosticFailure}>{diagnostic.lastFailure}</Text> : null}
                                {diagnostic.skippedReason ? <Text style={styles.diagnosticFailure}>{diagnostic.skippedReason}</Text> : null}
                              </View>
                            );
                          })}
                        </View>
                      ))}
                    </View>
                  ) : null}
                  {manualSearchResponse.results.length ? (
                    <View style={styles.manualResultList}>
                      {manualSearchResponse.results.slice(0, 5).map((result) => (
                        <View key={`${result.url}-${result.title}`} style={styles.manualResultRow}>
                          <Text style={styles.manualResultTitle}>{result.title}</Text>
                          <Text numberOfLines={1} style={styles.manualResultUrl}>{result.url}</Text>
                          <Text style={styles.manualResultMeta}>
                            {[result.engine, result.provider].filter(Boolean).join(' · ') || '未知来源'}
                          </Text>
                          {result.snippet ? <Text style={styles.manualResultSnippet}>{result.snippet}</Text> : null}
                        </View>
                      ))}
                    </View>
                  ) : (
                    <Text style={styles.emptyText}>没有返回搜索结果，先看上面的 provider 诊断。</Text>
                  )}
                </View>
              ) : null}
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>GitHub 凭据</Text>
              <Text style={styles.cardDescription}>Token 只保存在宿主侧，用来调用 GitHub REST API；白云和工具回执只会看到脱敏状态。</Text>
              <Text style={styles.fieldLabel}>当前状态</Text>
              <Text style={styles.fieldHint}>
                {githubConfigStatus?.hasToken
                  ? `已配置 Token · 末尾 ${githubConfigStatus.tokenSuffix} · ${githubConfigStatus.baseUrlHost}`
                  : `未配置 Token · ${githubConfigStatus?.baseUrlHost ?? 'api.github.com'}`}
              </Text>
              <Text style={styles.fieldLabel}>GitHub API 地址</Text>
              <View style={styles.searchInputRow}>
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={setGithubApiBaseUrl}
                  placeholder="https://api.github.com"
                  placeholderTextColor="#B9A6A0"
                  returnKeyType="done"
                  style={styles.searchInput}
                  value={githubApiBaseUrl}
                />
              </View>
              <Text style={styles.fieldLabel}>GitHub Token</Text>
              <View style={styles.searchInputRow}>
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={setGithubTokenInput}
                  placeholder={githubConfigStatus?.hasToken ? '已保存；输入新 token 可替换' : '粘贴 GitHub token'}
                  placeholderTextColor="#B9A6A0"
                  returnKeyType="done"
                  secureTextEntry
                  style={styles.searchInput}
                  value={githubTokenInput}
                />
              </View>
              <Text style={styles.fieldHint}>留空保存时只更新 API 地址，不会清掉旧 Token；删除按钮才会移除 Token。</Text>
              {githubCredentialNotice ? <Text style={styles.backendNotice}>{githubCredentialNotice}</Text> : null}
              <View style={styles.quickGrantRow}>
                <Pressable onPress={saveGithubCredential} style={styles.quickGrantButton}>
                  <Text style={styles.quickGrantText}>保存 GitHub 凭据</Text>
                </Pressable>
                <Pressable onPress={refreshGithubConfigStatus} style={styles.quickGrantButtonMuted}>
                  <Text style={styles.quickGrantTextMuted}>检查状态</Text>
                </Pressable>
                <Pressable onPress={deleteGithubCredential} style={styles.quickGrantButtonMuted}>
                  <Text style={styles.quickGrantTextMuted}>删除 Token</Text>
                </Pressable>
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>外部工具试验区</Text>
              <Text style={styles.cardDescription}>这里只接 HTTPS JSON-RPC MCP 的只读试点；stdio、电脑 MCP、小红书 MCP 和 ToolPkg 执行都没有开启。</Text>
              <Text style={styles.fieldLabel}>新增 HTTPS MCP endpoint</Text>
              <View style={styles.searchInputRow}>
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={setMcpEndpointInput}
                  placeholder="https://example.com/mcp"
                  placeholderTextColor="#B9A6A0"
                  returnKeyType="done"
                  style={styles.searchInput}
                  value={mcpEndpointInput}
                />
              </View>
              <Text style={styles.fieldLabel}>显示名称</Text>
              <View style={styles.searchInputRow}>
                <TextInput
                  autoCorrect={false}
                  onChangeText={setMcpNameInput}
                  placeholder="例如 只读资料 MCP"
                  placeholderTextColor="#B9A6A0"
                  returnKeyType="done"
                  style={styles.searchInput}
                  value={mcpNameInput}
                />
                <Pressable onPress={addMcpServer} style={styles.saveBackendButton}>
                  <Text style={styles.saveBackendButtonText}>保存</Text>
                </Pressable>
              </View>
              <Text style={styles.fieldHint}>Token 不通过工具调用传递，避免出现在审计和工具卡片里；保存后只显示已配置和尾号。</Text>
              {mcpNotice ? <Text style={styles.backendNotice}>{mcpNotice}</Text> : null}
              {mcpServers.length ? (
                <View style={styles.manualResultList}>
                  {mcpServers.map((server) => (
                    <View key={server.serverId} style={styles.manualResultRow}>
                      <Text style={styles.manualResultTitle}>{server.name}</Text>
                      <Text numberOfLines={1} style={styles.manualResultUrl}>{server.endpoint}</Text>
                      <Text style={styles.manualResultMeta}>
                        {server.serverId} · {server.hasToken ? `Token 末尾 ${server.tokenTail}` : '未配置 Token'} · {server.lastSyncedAt ? `上次同步 ${formatTime(server.lastSyncedAt)}` : '尚未同步'}
                      </Text>
                      {server.lastError ? <Text style={styles.auditError}>{server.lastError}</Text> : null}
                      {server.skippedTools?.length ? <Text style={styles.fieldHint}>跳过 {server.skippedTools.length} 个非只读或无法判定工具。</Text> : null}
                      <View style={styles.searchInputRow}>
                        <TextInput
                          autoCapitalize="none"
                          autoCorrect={false}
                          onChangeText={(value) => setMcpTokenInputById((current) => ({ ...current, [server.serverId]: value }))}
                          placeholder={server.hasToken ? '已保存；输入新 token 可替换' : '可选 token'}
                          placeholderTextColor="#B9A6A0"
                          returnKeyType="done"
                          secureTextEntry
                          style={styles.searchInput}
                          value={mcpTokenInputById[server.serverId] ?? ''}
                        />
                      </View>
                      <View style={styles.quickGrantRow}>
                        <Pressable onPress={() => saveMcpToken(server.serverId)} style={styles.quickGrantButtonMuted}>
                          <Text style={styles.quickGrantTextMuted}>保存 Token</Text>
                        </Pressable>
                        <Pressable onPress={() => syncMcpServer(server.serverId)} style={styles.quickGrantButton}>
                          <Text style={styles.quickGrantText}>{mcpSyncingId === server.serverId ? '同步中' : '同步只读工具'}</Text>
                        </Pressable>
                        <Pressable onPress={() => removeMcpServer(server.serverId)} style={styles.quickGrantButtonMuted}>
                          <Text style={styles.quickGrantTextMuted}>移除</Text>
                        </Pressable>
                      </View>
                    </View>
                  ))}
                </View>
              ) : (
                <Text style={styles.emptyText}>还没有登记 MCP server。</Text>
              )}
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>全局默认权限</Text>
              <Text style={styles.cardDescription}>没有单独覆盖时，工具会先参考这里，再参考工具定义和风险等级。</Text>
              <PermissionSegment
                choices={GLOBAL_PERMISSION_CHOICES}
                value={snapshot.permissions.globalDefault}
                onChange={updateGlobalPermission}
              />
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>危险实验区</Text>
              <Text style={styles.cardDescription}>这里集中提醒哪些能力只是可见边界或默认拒绝，不代表白云可以静默执行。</Text>
              <View style={styles.badgeRow}>
                <Text style={styles.badge}>developer_lab 默认关闭</Text>
                <Text style={styles.badge}>危险文件默认拒绝</Text>
                <Text style={styles.badge}>GitHub 远端改写默认拒绝</Text>
                <Text style={styles.badge}>MCP 仅 HTTPS 只读试点</Text>
              </View>
              <Text style={styles.fieldHint}>未上线：浏览器点击/输入/登录、社交自动化、小红书自动化、stdio/电脑 MCP、ToolPkg 执行、terminal、Shizuku shell、MCP 写入工具自动路由。</Text>
            </View>

            {filteredPackages.map((toolPackage) => {
              const packageTools = toolsByPackage.get(toolPackage.id) ?? [];
              const packagePermission = snapshot.permissions.packageOverrides[toolPackage.id];
              const packageTemporaryGrant = snapshot.activeGrants.find((grant) =>
                grant.scope === 'package' && grant.targetId === toolPackage.id
              );
              return (
                <View key={toolPackage.id} style={styles.packageCard}>
                  <View style={styles.packageHeader}>
                    <View style={styles.packageTitleBlock}>
                      <Text style={styles.packageName}>{toolPackage.name}</Text>
                      <Text style={styles.packageMeta}>{riskLabel(toolPackage.riskLevel)}</Text>
                    </View>
                    <Text style={styles.packageCount}>{packageTools.length} 个工具</Text>
                  </View>
                  <Text style={styles.packageDescription}>{toolPackage.description}</Text>
                  <View style={styles.badgeRow}>
                    <Text style={styles.badge}>{toolPackage.defaultEnabled ? '默认启用' : '默认关闭'}</Text>
                    <Text style={styles.badge}>包权限：{permissionLabel(packagePermission)}</Text>
                    <Text style={styles.badge}>预授权：{temporaryGrantLabel(packageTemporaryGrant)}</Text>
                  </View>
                  <PermissionSegment
                    choices={PERMISSION_CHOICES}
                    value={packagePermission ?? 'inherit'}
                    onChange={(permission) => updatePackagePermission(toolPackage.id, permission)}
                  />
                  <View style={styles.quickGrantRow}>
                    <Pressable onPress={() => grantPackageForSession(toolPackage.id)} style={styles.quickGrantButton}>
                      <Text style={styles.quickGrantText}>本轮允许</Text>
                    </Pressable>
                    <Pressable onPress={() => grantPackageForToday(toolPackage.id)} style={styles.quickGrantButton}>
                      <Text style={styles.quickGrantText}>今日允许</Text>
                    </Pressable>
                    <Pressable onPress={() => clearTemporaryGrants('package', toolPackage.id)} style={styles.quickGrantButtonMuted}>
                      <Text style={styles.quickGrantTextMuted}>清除临时</Text>
                    </Pressable>
                  </View>

                  <View style={styles.toolList}>
                    {packageTools.map((tool) => {
                      const toolPermission = snapshot.permissions.toolOverrides[tool.id];
                      const toolTemporaryGrant = snapshot.activeGrants.find((grant) =>
                        grant.scope === 'tool' && grant.targetId === tool.id
                      );
                      return (
                        <View key={tool.id} style={styles.toolRow}>
                          <View style={styles.toolCopy}>
                            <Text style={styles.toolName}>{tool.name}</Text>
                            <Text style={styles.toolMeta}>{riskLabel(tool.riskLevel)} · {tool.readOnly ? '只读' : '会执行动作'}</Text>
                            <Text style={styles.toolDescription}>{tool.description}</Text>
                            <Text style={styles.toolDefault}>工具默认：{permissionLabel(tool.permission)} · 当前覆盖：{permissionLabel(toolPermission)}</Text>
                            <Text style={styles.toolDefault}>预授权：{temporaryGrantLabel(toolTemporaryGrant)}</Text>
                          </View>
                          <PermissionSegment
                            choices={PERMISSION_CHOICES}
                            value={toolPermission ?? 'inherit'}
                            onChange={(permission) => updateToolPermission(tool.id, permission)}
                          />
                          <View style={styles.quickGrantRow}>
                            <Pressable onPress={() => grantToolForSession(tool.id)} style={styles.quickGrantButton}>
                              <Text style={styles.quickGrantText}>本轮允许</Text>
                            </Pressable>
                            <Pressable onPress={() => grantToolForToday(tool.id)} style={styles.quickGrantButton}>
                              <Text style={styles.quickGrantText}>今日允许</Text>
                            </Pressable>
                            <Pressable onPress={() => clearTemporaryGrants('tool', tool.id)} style={styles.quickGrantButtonMuted}>
                              <Text style={styles.quickGrantTextMuted}>清除临时</Text>
                            </Pressable>
                          </View>
                        </View>
                      );
                    })}
                  </View>
                </View>
              );
            })}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.summaryCard}>
      <Text style={styles.summaryValue}>{value}</Text>
      <Text style={styles.summaryLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  auditError: {
    color: '#B7685D',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 3,
  },
  backendNotice: {
    color: '#7A9A86',
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 18,
    marginBottom: 10,
    marginTop: 7,
  },
  backButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#FFE2DA',
    borderRadius: 22,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  backText: {
    color: colors.ink,
    fontSize: 32,
    lineHeight: 34,
  },
  badge: {
    backgroundColor: '#FFF1EC',
    borderRadius: 10,
    color: '#9A6258',
    fontSize: 12,
    fontWeight: '700',
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
    marginBottom: 11,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderColor: '#F6DFD9',
    borderRadius: 18,
    borderWidth: 1,
    marginBottom: 15,
    padding: 15,
  },
  cardDescription: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 12,
  },
  cardTitle: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 6,
  },
  content: {
    paddingBottom: 34,
  },
  diagnosticFailure: {
    color: '#B7685D',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 4,
  },
  diagnosticGroup: {
    gap: 7,
  },
  diagnosticGroupTitle: {
    color: '#7D9A8B',
    fontSize: 12,
    fontWeight: '900',
    marginTop: 2,
  },
  diagnosticList: {
    gap: 12,
    marginTop: 10,
  },
  diagnosticMeta: {
    color: '#9A8883',
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2,
  },
  diagnosticName: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '800',
  },
  diagnosticRow: {
    backgroundColor: '#FFF9F5',
    borderColor: '#F3DED5',
    borderRadius: 12,
    borderWidth: 1,
    padding: 10,
  },
  emptyText: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 9,
  },
  fieldHint: {
    color: '#9A8883',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 6,
  },
  fieldLabel: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '900',
    marginBottom: 7,
    marginTop: 11,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    height: 58,
    justifyContent: 'space-between',
    marginBottom: 18,
  },
  loadingText: {
    color: '#9C7D76',
    fontSize: 13,
    marginBottom: 10,
    textAlign: 'center',
  },
  packageCard: {
    backgroundColor: '#FFFFFF',
    borderColor: '#F6DFD9',
    borderRadius: 18,
    borderWidth: 1,
    marginBottom: 15,
    padding: 15,
  },
  packageCount: {
    color: '#9C7D76',
    fontSize: 12,
    fontWeight: '700',
  },
  packageDescription: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 10,
  },
  packageHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  packageMeta: {
    color: '#9A8883',
    fontSize: 12,
    marginTop: 3,
  },
  packageName: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '800',
  },
  packageTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  page: {
    backgroundColor: '#FFF9F4',
    flex: 1,
    paddingHorizontal: 18,
    paddingTop: 24,
  },
  refreshButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#FFE2DA',
    borderRadius: 16,
    borderWidth: 1,
    height: 36,
    justifyContent: 'center',
    paddingHorizontal: 13,
  },
  refreshText: {
    color: '#B87669',
    fontSize: 13,
    fontWeight: '800',
  },
  quickGrantButton: {
    backgroundColor: '#EAF6EF',
    borderColor: '#B9DDC7',
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  quickGrantButtonMuted: {
    backgroundColor: '#FFF9F5',
    borderColor: '#F2DDD6',
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  quickGrantRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
    marginTop: 9,
  },
  quickGrantText: {
    color: '#5D8A70',
    fontSize: 12,
    fontWeight: '900',
  },
  quickGrantTextMuted: {
    color: '#9A6258',
    fontSize: 12,
    fontWeight: '900',
  },
  manualResultList: {
    gap: 9,
    marginTop: 10,
  },
  manualResultMeta: {
    color: '#9C7D76',
    fontSize: 12,
    marginTop: 3,
  },
  manualResultRow: {
    backgroundColor: '#FFFFFF',
    borderColor: '#F3DED5',
    borderRadius: 12,
    borderWidth: 1,
    padding: 11,
  },
  manualResultSnippet: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 5,
  },
  manualResultTitle: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
    lineHeight: 20,
  },
  manualResultUrl: {
    color: '#7D9A8B',
    fontSize: 12,
    marginTop: 3,
  },
  searchButton: {
    alignItems: 'center',
    backgroundColor: '#F2A393',
    borderRadius: 14,
    height: 46,
    justifyContent: 'center',
    minWidth: 72,
    paddingHorizontal: 14,
  },
  searchButtonDisabled: {
    opacity: 0.52,
  },
  searchButtonPressed: {
    backgroundColor: '#E89180',
  },
  searchButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '900',
  },
  saveBackendButton: {
    alignItems: 'center',
    backgroundColor: '#EAF6EF',
    borderColor: '#B9DDC7',
    borderRadius: 14,
    borderWidth: 1,
    height: 46,
    justifyContent: 'center',
    minWidth: 64,
    paddingHorizontal: 13,
  },
  saveBackendButtonPressed: {
    backgroundColor: '#DDF0E5',
  },
  saveBackendButtonText: {
    color: '#5D8A70',
    fontSize: 14,
    fontWeight: '900',
  },
  searchInput: {
    backgroundColor: '#FFF9F5',
    borderColor: '#F2DDD6',
    borderRadius: 14,
    borderWidth: 1,
    color: colors.ink,
    flex: 1,
    fontSize: 15,
    minHeight: 46,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  searchInputRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 9,
  },
  searchResultBlock: {
    backgroundColor: '#FFF4EF',
    borderColor: '#F3DED5',
    borderRadius: 14,
    borderWidth: 1,
    marginTop: 12,
    padding: 12,
  },
  searchResultTitle: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '900',
  },
  segment: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  segmentButton: {
    backgroundColor: '#FFF9F5',
    borderColor: '#F2DDD6',
    borderRadius: 12,
    borderWidth: 1,
    minWidth: 52,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  segmentButtonPressed: {
    backgroundColor: '#FFF0EA',
  },
  segmentButtonSelected: {
    backgroundColor: '#F2A393',
    borderColor: '#F2A393',
  },
  segmentText: {
    color: '#9A6258',
    fontSize: 12,
    fontWeight: '800',
    textAlign: 'center',
  },
  segmentTextSelected: {
    color: '#FFFFFF',
  },
  summaryCard: {
    backgroundColor: '#FFFFFF',
    borderColor: '#F6DFD9',
    borderRadius: 16,
    borderWidth: 1,
    flex: 1,
    minWidth: '45%',
    padding: 13,
  },
  summaryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 15,
  },
  summaryLabel: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 3,
  },
  summaryValue: {
    color: colors.ink,
    fontSize: 20,
    fontWeight: '900',
  },
  title: {
    color: colors.ink,
    flex: 1,
    fontSize: 25,
    fontWeight: '800',
    marginHorizontal: 12,
    textAlign: 'center',
  },
  toolCopy: {
    gap: 3,
    marginBottom: 9,
  },
  toolDefault: {
    color: '#9C7D76',
    fontSize: 12,
    marginTop: 2,
  },
  toolDescription: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 18,
  },
  toolList: {
    gap: 10,
    marginTop: 13,
  },
  toolMeta: {
    color: '#9A8883',
    fontSize: 12,
  },
  toolName: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '800',
  },
  toolRow: {
    backgroundColor: '#FFF9F5',
    borderColor: '#F3DED5',
    borderRadius: 14,
    borderWidth: 1,
    padding: 12,
  },
});

