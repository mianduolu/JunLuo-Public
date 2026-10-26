import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { AppText as Text } from '../components/AppText';
import {
  commitAndroidSecretPackageImportV1,
  countExportableLocalSecretsV1,
  createAndroidSecretPackageExportV1,
  deleteAndroidSecretPackageExportV1,
  discardAndroidSecretPackagePreviewV1,
  previewAndroidSecretPackageImportV1,
  type SecretPackageImportPreviewV1,
} from '../secretPackage/secretPackageAndroidController';
import {
  normalizeSecretPackagePasswordV1,
} from '../secretPackage/secretPackageCore';
import type { Navigate } from '../types/navigation';

type Props = {
  navigate: Navigate;
};

type Mode = 'home' | 'export-password' | 'import-password' | 'preview';

const IMPORT_FAILURE =
  '秘密包无法打开：口令不正确，或文件已损坏。这台设备没有发生改动。';

function passwordIsValid(value: string) {
  try {
    normalizeSecretPackagePasswordV1(value);
    return true;
  } catch {
    return false;
  }
}

function PasswordField({
  placeholder,
  value,
  onChangeText,
}: {
  placeholder: string;
  value: string;
  onChangeText: (value: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <View style={styles.passwordRow}>
      <TextInput
        accessibilityLabel={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#9AA8AE"
        secureTextEntry={!visible}
        style={styles.passwordInput}
        value={value}
      />
      <Pressable
        accessibilityLabel={visible ? '隐藏口令' : '显示口令'}
        onPress={() => setVisible((current) => !current)}
        style={({ pressed }) => [
          styles.visibilityButton,
          pressed && styles.buttonPressed,
        ]}
      >
        <Text style={styles.visibilityText}>{visible ? '隐藏' : '显示'}</Text>
      </Pressable>
    </View>
  );
}

export function SecretPackageScreen({ navigate }: Props) {
  const [mode, setMode] = useState<Mode>('home');
  const [exportableCount, setExportableCount] = useState<number | null>(null);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [selectedUri, setSelectedUri] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState('');
  const [preview, setPreview] = useState<SecretPackageImportPreviewV1 | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let mounted = true;
    void countExportableLocalSecretsV1()
      .then((count) => {
        if (mounted) setExportableCount(count);
      })
      .catch(() => {
        if (mounted) setExportableCount(0);
      });
    return () => {
      mounted = false;
      if (preview) discardAndroidSecretPackagePreviewV1(preview.handle);
    };
  }, [preview]);

  const passwordValid = useMemo(
    () => passwordIsValid(password),
    [password],
  );
  const exportReady = passwordValid && confirmation === password;

  const resetSensitiveUi = () => {
    if (selectedUri) {
      void deleteAndroidSecretPackageExportV1(selectedUri).catch(
        () => undefined,
      );
    }
    setPassword('');
    setConfirmation('');
    setSelectedUri(null);
    setSelectedName('');
    if (preview) discardAndroidSecretPackagePreviewV1(preview.handle);
    setPreview(null);
    setProgress(0);
  };

  const returnHome = () => {
    resetSensitiveUi();
    setNotice('');
    setMode('home');
  };

  const exportPackage = async () => {
    if (!exportReady || busy) return;
    setBusy(true);
    setNotice('');
    setProgress(0);
    let uri: string | null = null;
    try {
      const exported = await createAndroidSecretPackageExportV1({
        password,
        onProgress: setProgress,
      });
      uri = exported.uri;
      if (!(await Sharing.isAvailableAsync())) {
        throw new Error('系统分享菜单当前不可用。');
      }
      await Sharing.shareAsync(exported.uri, {
        dialogTitle: '导出秘密包',
        mimeType: 'application/octet-stream',
        UTI: 'public.data',
      });
      returnHome();
      setExportableCount(exported.count);
    } catch {
      setNotice(
        exportableCount === 0
          ? '没有可导出的服务凭据。'
          : '操作没有完成，请稍后再试。',
      );
    } finally {
      if (uri) await deleteAndroidSecretPackageExportV1(uri).catch(() => undefined);
      setBusy(false);
      setProgress(0);
    }
  };

  const choosePackage = async () => {
    if (busy) return;
    setNotice('');
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: false,
      type: '*/*',
    });
    if (result.canceled || result.assets.length !== 1) return;
    const asset = result.assets[0];
    if (!asset.name.toLowerCase().endsWith('.jlsecret')) {
      setNotice(IMPORT_FAILURE);
      return;
    }
    resetSensitiveUi();
    setSelectedUri(asset.uri);
    setSelectedName(asset.name);
    setMode('import-password');
  };

  const openPreview = async () => {
    if (!selectedUri || !passwordValid || busy) return;
    setBusy(true);
    setNotice('');
    setProgress(0);
    try {
      const next = await previewAndroidSecretPackageImportV1({
        uri: selectedUri,
        password,
        onProgress: setProgress,
      });
      await deleteAndroidSecretPackageExportV1(selectedUri).catch(
        () => undefined,
      );
      setSelectedUri(null);
      setSelectedName('');
      setPassword('');
      setPreview(next);
      setMode('preview');
    } catch {
      setNotice(IMPORT_FAILURE);
    } finally {
      setBusy(false);
      setProgress(0);
    }
  };

  const commitImport = async () => {
    if (!preview || busy) return;
    setBusy(true);
    setNotice('');
    try {
      const count = await commitAndroidSecretPackageImportV1(preview.handle);
      resetSensitiveUi();
      setMode('home');
      setNotice(`已导入 ${count} 项服务凭据。`);
      setExportableCount(await countExportableLocalSecretsV1());
    } catch {
      setNotice(IMPORT_FAILURE);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="返回设置"
          onPress={() => {
            resetSensitiveUi();
            navigate('settings');
          }}
          style={({ pressed }) => [styles.backButton, pressed && styles.buttonPressed]}
        >
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>PRIVATE · PORTABLE</Text>
          <Text style={styles.title}>君落秘密包</Text>
        </View>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.hero}>
          <View style={styles.lockBadge}><Text style={styles.lockGlyph}>◇</Text></View>
          <Text style={styles.intro}>
            把君落使用的 API Key、服务 token 和已登记的网易云登录态装进一个加密文件。它不包含聊天、记忆、同步钥匙或设备身份。
          </Text>
          {exportableCount !== null ? (
            <Text style={styles.countLabel}>{exportableCount} 项服务凭据</Text>
          ) : null}
        </View>

        {mode === 'home' ? (
          <>
            <View style={styles.card}>
              <Text style={styles.cardLabel}>EXPORT</Text>
              <Text style={styles.cardTitle}>导出到加密文件</Text>
              <Text style={styles.cardDescription}>
                以后导入时需要输入这个口令。君落不会保存口令，也没有恢复卡；忘记后，请从仍能使用的设备重新导出。
              </Text>
              <Pressable
                disabled={busy || exportableCount === 0}
                onPress={() => {
                  setNotice('');
                  setMode('export-password');
                }}
                style={({ pressed }) => [
                  styles.primaryButton,
                  pressed && styles.buttonPressed,
                  exportableCount === 0 && styles.buttonDisabled,
                ]}
              >
                <Text style={styles.primaryButtonText}>导出秘密包</Text>
              </Pressable>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardLabel}>IMPORT</Text>
              <Text style={styles.cardTitle}>导入到这台设备</Text>
              <Text style={styles.cardDescription}>
                君落会先检查全部内容，再更新包内同名凭据；包里没有的本机凭据保持不变。
              </Text>
              <Pressable
                disabled={busy}
                onPress={() => void choosePackage()}
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}
              >
                <Text style={styles.secondaryButtonText}>选择秘密包</Text>
              </Pressable>
            </View>
          </>
        ) : null}

        {mode === 'export-password' ? (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>PASSWORD</Text>
            <Text style={styles.cardTitle}>给秘密包设置口令</Text>
            <Text style={styles.cardDescription}>
              以后导入时需要输入这个口令。君落不会保存口令，也没有恢复卡；忘记后，请从仍能使用的设备重新导出。
            </Text>
            <PasswordField placeholder="输入口令" value={password} onChangeText={setPassword} />
            <PasswordField placeholder="再次输入" value={confirmation} onChangeText={setConfirmation} />
            <Progress progress={progress} visible={busy} />
            <View style={styles.actionRow}>
              <Pressable disabled={busy} onPress={returnHome} style={styles.smallButton}>
                <Text style={styles.smallButtonText}>返回</Text>
              </Pressable>
              <Pressable
                disabled={!exportReady || busy}
                onPress={() => void exportPackage()}
                style={({ pressed }) => [
                  styles.primaryButton,
                  styles.flexButton,
                  pressed && styles.buttonPressed,
                  (!exportReady || busy) && styles.buttonDisabled,
                ]}
              >
                {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryButtonText}>导出秘密包</Text>}
              </Pressable>
            </View>
          </View>
        ) : null}

        {mode === 'import-password' ? (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>OPEN PACKAGE</Text>
            <Text style={styles.cardTitle}>选择秘密包</Text>
            <Text numberOfLines={1} style={styles.fileName}>{selectedName}</Text>
            <PasswordField placeholder="输入口令" value={password} onChangeText={setPassword} />
            <Progress progress={progress} visible={busy} />
            <View style={styles.actionRow}>
              <Pressable disabled={busy} onPress={returnHome} style={styles.smallButton}>
                <Text style={styles.smallButtonText}>返回</Text>
              </Pressable>
              <Pressable
                disabled={!passwordValid || busy}
                onPress={() => void openPreview()}
                style={({ pressed }) => [
                  styles.primaryButton,
                  styles.flexButton,
                  pressed && styles.buttonPressed,
                  (!passwordValid || busy) && styles.buttonDisabled,
                ]}
              >
                {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryButtonText}>打开秘密包</Text>}
              </Pressable>
            </View>
          </View>
        ) : null}

        {mode === 'preview' && preview ? (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>CHECKED</Text>
            <Text style={styles.cardTitle}>准备导入 {preview.count} 项服务凭据</Text>
            <View style={styles.previewList}>
              {preview.items.map((item) => (
                <View key={item.secretId} style={styles.previewItem}>
                  <Text style={styles.previewLabel}>{item.label}</Text>
                  <Text style={styles.previewAction}>{item.action}</Text>
                </View>
              ))}
            </View>
            <View style={styles.actionRow}>
              <Pressable disabled={busy} onPress={returnHome} style={styles.smallButton}>
                <Text style={styles.smallButtonText}>返回</Text>
              </Pressable>
              <Pressable
                disabled={busy}
                onPress={() => void commitImport()}
                style={({ pressed }) => [styles.primaryButton, styles.flexButton, pressed && styles.buttonPressed]}
              >
                {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryButtonText}>导入到这台设备</Text>}
              </Pressable>
            </View>
          </View>
        ) : null}

        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      </ScrollView>
    </View>
  );
}

function Progress({ progress, visible }: { progress: number; visible: boolean }) {
  if (!visible) return null;
  return (
    <View style={styles.progressTrack}>
      <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#F6FBFA' },
  header: {
    minHeight: 78,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    borderBottomWidth: 1,
    borderBottomColor: '#DCEBE8',
    backgroundColor: 'rgba(255,255,255,0.94)',
  },
  backButton: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#D5E6E2',
    backgroundColor: '#FFFFFF',
  },
  backText: { fontSize: 36, lineHeight: 38, color: '#31464F' },
  headerCopy: { flex: 1, alignItems: 'center' },
  eyebrow: { fontSize: 11, fontWeight: '800', letterSpacing: 1.8, color: '#6A9C91' },
  title: { marginTop: 3, fontSize: 25, fontWeight: '900', color: '#2F4350' },
  headerSpacer: { width: 48 },
  content: { padding: 18, paddingBottom: 44, gap: 16 },
  hero: {
    padding: 22,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: '#CBE4DE',
    backgroundColor: '#E8F6F2',
  },
  lockBadge: {
    width: 46,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    backgroundColor: '#FFFFFF',
  },
  lockGlyph: { fontSize: 24, color: '#5B9487' },
  intro: { marginTop: 16, fontSize: 16, lineHeight: 25, color: '#405A62' },
  countLabel: { marginTop: 13, fontSize: 14, fontWeight: '800', color: '#5B9487' },
  card: {
    padding: 20,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#E2EBE9',
    backgroundColor: '#FFFFFF',
    shadowColor: '#72948C',
    shadowOpacity: 0.08,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 5 },
    elevation: 2,
  },
  cardLabel: { fontSize: 11, fontWeight: '900', letterSpacing: 1.8, color: '#82A79E' },
  cardTitle: { marginTop: 8, fontSize: 21, fontWeight: '900', color: '#2F4350' },
  cardDescription: { marginTop: 10, fontSize: 15, lineHeight: 23, color: '#667980' },
  primaryButton: {
    minHeight: 50,
    marginTop: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 17,
    backgroundColor: '#5C8E86',
  },
  primaryButtonText: { fontSize: 16, fontWeight: '900', color: '#FFFFFF' },
  secondaryButton: {
    minHeight: 50,
    marginTop: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 17,
    borderWidth: 1,
    borderColor: '#BFD9D3',
    backgroundColor: '#F4FBF9',
  },
  secondaryButtonText: { fontSize: 16, fontWeight: '900', color: '#4E7D75' },
  buttonPressed: { opacity: 0.72, transform: [{ scale: 0.985 }] },
  buttonDisabled: { opacity: 0.42 },
  passwordRow: {
    minHeight: 52,
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#CADDD9',
    borderRadius: 16,
    backgroundColor: '#F8FCFB',
    overflow: 'hidden',
  },
  passwordInput: { flex: 1, minHeight: 52, paddingHorizontal: 15, fontSize: 16, color: '#31464F' },
  visibilityButton: { minWidth: 58, minHeight: 52, alignItems: 'center', justifyContent: 'center' },
  visibilityText: { fontSize: 15, fontWeight: '800', color: '#5C8E86' },
  actionRow: { marginTop: 6, flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  smallButton: {
    minWidth: 74,
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 17,
    borderWidth: 1,
    borderColor: '#D6E4E1',
    backgroundColor: '#FFFFFF',
  },
  smallButtonText: { fontSize: 15, fontWeight: '800', color: '#6B7C82' },
  flexButton: { flex: 1 },
  progressTrack: { height: 6, marginTop: 16, borderRadius: 6, backgroundColor: '#E4EFEC', overflow: 'hidden' },
  progressFill: { height: 6, borderRadius: 6, backgroundColor: '#65B7A5' },
  fileName: { marginTop: 12, fontSize: 15, fontWeight: '700', color: '#5D747A' },
  previewList: { marginTop: 15, gap: 8 },
  previewItem: {
    minHeight: 48,
    paddingHorizontal: 13,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    borderRadius: 14,
    backgroundColor: '#F2F8F6',
  },
  previewLabel: { flex: 1, fontSize: 15, fontWeight: '800', color: '#3F5960' },
  previewAction: { fontSize: 14, fontWeight: '800', color: '#5C9488' },
  notice: {
    padding: 15,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#F2CBC4',
    backgroundColor: '#FFF2EF',
    fontSize: 15,
    lineHeight: 22,
    color: '#A45F57',
  },
});
