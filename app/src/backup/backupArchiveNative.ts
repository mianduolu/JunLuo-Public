import { NativeModules, Platform } from 'react-native';

type ArchiveResult = {
  entryCount: number;
  sourceBytes?: number;
  archiveBytes?: number;
  totalBytes?: number;
};

type JunLuoBackupArchiveModule = {
  createArchive(sourceDirectoryUri: string, targetArchiveUri: string): Promise<string>;
  extractArchive(sourceArchiveUri: string, targetDirectoryUri: string): Promise<string>;
  validateDatabase(sourceDatabaseUri: string): Promise<string>;
  cleanupTemporaryFiles(): Promise<number>;
  reloadApplication(): Promise<boolean>;
};

const nativeModule = NativeModules.JunLuoBackupArchive as JunLuoBackupArchiveModule | undefined;

export function canUseNativeBackupArchive() {
  return Platform.OS === 'android' && !!nativeModule;
}

function requireNativeModule() {
  if (!nativeModule) {
    throw new Error('当前开发版还没有安装流式备份模块，请重新覆盖安装君落开发版。');
  }
  return nativeModule;
}

function parseResult(value: string): ArchiveResult {
  return JSON.parse(value) as ArchiveResult;
}

export async function createNativeArchive(sourceDirectoryUri: string, targetArchiveUri: string) {
  return parseResult(await requireNativeModule().createArchive(sourceDirectoryUri, targetArchiveUri));
}

export async function extractNativeArchive(sourceArchiveUri: string, targetDirectoryUri: string) {
  return parseResult(await requireNativeModule().extractArchive(sourceArchiveUri, targetDirectoryUri));
}

export async function validateNativeDatabase(sourceDatabaseUri: string) {
  const result = await requireNativeModule().validateDatabase(sourceDatabaseUri);
  if (result !== 'ok') throw new Error(result || 'quick_check did not return ok');
}

export async function cleanupNativeBackupTemporaryFiles() {
  return requireNativeModule().cleanupTemporaryFiles();
}

export async function reloadJunLuoApplication() {
  await requireNativeModule().reloadApplication();
}
