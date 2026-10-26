import { NativeModules, Platform } from 'react-native';

export type ExternalFileImportKind = 'text' | 'zip' | 'epub' | 'raw' | 'unsupported';

export type ExternalFileSummary = {
  externalFileId: string;
  name: string;
  extension: string;
  path: string;
  directoryTag: string;
  size?: number;
  modifiedAt?: number;
  mimeType?: string;
  importKind?: ExternalFileImportKind;
};

export type ExternalFileDiagnostic = {
  directoryTag?: string;
  path?: string;
  status: string;
};

export type ExternalFilesStatus = {
  available: boolean;
  platform: 'android' | 'unsupported';
  hasAllFilesAccess: boolean;
  sdkInt?: number;
  scanRoots?: Array<{ directoryTag: string; path: string; exists: boolean; canRead: boolean }>;
};

type NativeExternalFilesModule = {
  copyFileToCache: (externalFileId: string) => Promise<string>;
  deleteFile: (externalFileId: string) => Promise<string>;
  getFileInfo: (externalFileId: string) => Promise<string>;
  getStatus: () => Promise<string>;
  moveFile: (externalFileId: string, targetDirectoryTag: string) => Promise<string>;
  openAccessSettings: () => Promise<boolean>;
  openFile: (externalFileId: string) => Promise<string>;
  overwriteFile: (externalFileId: string, sourceCacheUri: string) => Promise<string>;
  scanFiles: (optionsJson: string) => Promise<string>;
  shareFile: (externalFileId: string) => Promise<string>;
};

const nativeModule = NativeModules.JunLuoExternalFiles as NativeExternalFilesModule | undefined;

function unavailableStatus(): ExternalFilesStatus {
  return {
    available: false,
    platform: Platform.OS === 'android' ? 'android' : 'unsupported',
    hasAllFilesAccess: false,
  };
}

function parseJson<T>(raw: string | object | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  if (typeof raw === 'object') return raw as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function isExternalFilesNativeAvailable() {
  return Platform.OS === 'android' && !!nativeModule;
}

export async function getExternalFilesAccessStatus(): Promise<ExternalFilesStatus> {
  if (!isExternalFilesNativeAvailable() || !nativeModule) return unavailableStatus();
  return parseJson(await nativeModule.getStatus(), unavailableStatus());
}

export async function openExternalFilesAccessSettings() {
  if (!isExternalFilesNativeAvailable() || !nativeModule) return false;
  try {
    return await nativeModule.openAccessSettings();
  } catch {
    return false;
  }
}

export async function scanExternalFiles(options: Record<string, unknown>) {
  if (!isExternalFilesNativeAvailable() || !nativeModule) {
    return { ok: false, code: 'NATIVE_UNAVAILABLE', message: '当前安装包还没有外部文件扫描能力' };
  }
  return parseJson(await nativeModule.scanFiles(JSON.stringify(options)), { ok: false, code: 'SCAN_FAILED', message: '扫描外部文件失败' });
}

export async function getExternalFileInfo(externalFileId: string) {
  if (!isExternalFilesNativeAvailable() || !nativeModule) {
    return { ok: false, code: 'NATIVE_UNAVAILABLE', message: '当前安装包还没有外部文件扫描能力' };
  }
  return parseJson(await nativeModule.getFileInfo(externalFileId), { ok: false, code: 'FILE_INFO_FAILED', message: '读取外部文件信息失败' });
}

export async function copyExternalFileToCache(externalFileId: string) {
  if (!isExternalFilesNativeAvailable() || !nativeModule) {
    return { ok: false, code: 'NATIVE_UNAVAILABLE', message: '当前安装包还没有外部文件导入能力' };
  }
  return parseJson(await nativeModule.copyFileToCache(externalFileId), { ok: false, code: 'COPY_FAILED', message: '复制外部文件失败' });
}

export async function openExternalFile(externalFileId: string) {
  if (!isExternalFilesNativeAvailable() || !nativeModule) {
    return { ok: false, code: 'NATIVE_UNAVAILABLE', message: '当前安装包还没有外部文件打开能力' };
  }
  return parseJson(await nativeModule.openFile(externalFileId), { ok: false, code: 'OPEN_FAILED', message: '打开外部文件失败' });
}

export async function shareExternalFile(externalFileId: string) {
  if (!isExternalFilesNativeAvailable() || !nativeModule) {
    return { ok: false, code: 'NATIVE_UNAVAILABLE', message: '当前安装包还没有外部文件分享能力' };
  }
  return parseJson(await nativeModule.shareFile(externalFileId), { ok: false, code: 'SHARE_FAILED', message: '分享外部文件失败' });
}

export async function deleteExternalFile(externalFileId: string) {
  if (!isExternalFilesNativeAvailable() || !nativeModule) {
    return { ok: false, code: 'NATIVE_UNAVAILABLE', message: '当前安装包还没有外部文件删除能力' };
  }
  return parseJson(await nativeModule.deleteFile(externalFileId), { ok: false, code: 'DELETE_FAILED', message: '删除外部文件失败' });
}

export async function overwriteExternalFile(externalFileId: string, sourceCacheUri: string) {
  if (!isExternalFilesNativeAvailable() || !nativeModule) {
    return { ok: false, code: 'NATIVE_UNAVAILABLE', message: '当前安装包还没有外部文件覆盖能力' };
  }
  return parseJson(await nativeModule.overwriteFile(externalFileId, sourceCacheUri), { ok: false, code: 'OVERWRITE_FAILED', message: '覆盖外部文件失败' });
}

export async function moveExternalFile(externalFileId: string, targetDirectoryTag: string) {
  if (!isExternalFilesNativeAvailable() || !nativeModule) {
    return { ok: false, code: 'NATIVE_UNAVAILABLE', message: '当前安装包还没有外部文件移动能力' };
  }
  return parseJson(await nativeModule.moveFile(externalFileId, targetDirectoryTag), { ok: false, code: 'MOVE_FAILED', message: '移动外部文件失败' });
}
