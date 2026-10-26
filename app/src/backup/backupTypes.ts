export type BackupProgressStage =
  | 'export-preparing'
  | 'exporting-databases'
  | 'exporting-files'
  | 'creating-archive'
  | 'validating-archive'
  | 'validating-databases'
  | 'creating-snapshot'
  | 'restoring'
  | 'rolling-back'
  | 'reloading';

export type BackupStageCallback = (stage: BackupProgressStage) => void;

export type CreateBackupArchiveOptions = {
  strictMediaSnapshot?: boolean;
  includeCameraObservationsForRollback?: boolean;
  acceptedMissingPostImageIds?: readonly string[];
  acceptedMissingShiyingImageIds?: readonly string[];
  postCaptureAlreadyExclusive?: boolean;
  shiyingCaptureAlreadyExclusive?: boolean;
  preserveShiyingLocalStateForRollback?: boolean;
};
export type BackupArchiveResult = {
  uri: string;
  missingPostImageIds: string[];
  missingShiyingImageIds: string[];
};

export type RestoreBackupOptions = {
  acceptedMissingPostImageIds?: readonly string[];
  acceptedMissingShiyingImageIds?: readonly string[];
  onStage?: BackupStageCallback;
  cameraObservations?: 'replace' | 'preserve_local';
  acceptIgnoredLegacySecrets?: boolean;
};

export type RestoreBackupResult = {
  preImportSnapshotCreated: boolean;
  preImportSnapshotUri?: string;
  manifestVersion?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;
  missingPostImageIds?: string[];
  missingShiyingImageIds?: string[];
  missingDatabases: string[];
  rolledBack?: boolean;
  cameraObservations?: 'replaced' | 'preserved_local' | 'not_in_backup';
  ignoredLegacySecrets: boolean;
  syncRebuildRequired: boolean;
};

export type ShiyingBackupMissingImage = {
  imageId: string;
  recordId: string;
  recordDate: string;
  createdAt: number;
  imageOrdinal: number;
};

export class ShiyingMissingImagesError extends Error {
  readonly missingImages: ShiyingBackupMissingImage[];

  constructor(missingImages: readonly ShiyingBackupMissingImage[], readonly operation: 'export' | 'restore') {
    super(`这次${operation === 'export' ? '备份' : '还原'}有 ${missingImages.length} 张拾荧记录图片缺失。记录文字和图片位置仍可保留。`);
    this.name = 'ShiyingMissingImagesError';
    this.missingImages = missingImages.map(({ imageId, recordId, recordDate, createdAt, imageOrdinal }) => ({
      imageId, recordId, recordDate, createdAt, imageOrdinal,
    }));
  }

  get imageIds() {
    return this.missingImages.map((image) => image.imageId);
  }
}

export class LegacyBackupSecretsIgnoredNoticeRequiredError extends Error {
  constructor() {
    super('这份旧备份包含旧式秘密记录。君落只恢复生活资料，不导入或覆盖本机 Key。');
    this.name = 'LegacyBackupSecretsIgnoredNoticeRequiredError';
  }
}

export class CameraObservationRestoreChoiceRequiredError extends Error {
  readonly recordCount: number;

  constructor(recordCount: number) {
    super('这份备份包含结构化摄像头观察，需要单独选择是否替换本机观察历史。');
    this.name = 'CameraObservationRestoreChoiceRequiredError';
    this.recordCount = recordCount;
  }
}

export class BackupFormatError extends Error {
  constructor(message = '这不是可识别的君落备份文件。') {
    super(message);
    this.name = 'BackupFormatError';
  }
}

export class BackupDiskSpaceError extends Error {
  constructor(message = '手机可用空间不足，已经在覆盖现有数据前停止。') {
    super(message);
    this.name = 'BackupDiskSpaceError';
  }
}

export class BackupDatabaseValidationError extends Error {
  constructor(message = '备份里的数据库没有通过完整性检查，已经停止还原。') {
    super(message);
    this.name = 'BackupDatabaseValidationError';
  }
}

export class PreImportBackupSnapshotError extends Error {
  constructor(message = '导入前快照生成失败。为了保护当前数据，已经停止还原。') {
    super(message);
    this.name = 'PreImportBackupSnapshotError';
  }
}

export class BackupRestoreRolledBackError extends Error {
  readonly originalError: unknown;

  constructor(originalError: unknown) {
    const detail = originalError instanceof Error ? originalError.message : '未知错误';
    super(`还原没有完成，但君落已经自动恢复到导入前的状态。原因：${detail}`);
    this.name = 'BackupRestoreRolledBackError';
    this.originalError = originalError;
  }
}

export class BackupRollbackFailedError extends Error {
  readonly originalError: unknown;
  readonly rollbackError: unknown;
  readonly snapshotUri: string;

  constructor(originalError: unknown, rollbackError: unknown, snapshotUri: string) {
    const originalDetail = originalError instanceof Error ? originalError.message : '未知错误';
    const rollbackDetail = rollbackError instanceof Error ? rollbackError.message : '未知错误';
    super(`还原失败，自动回滚也没有完成。导入前快照仍保留在本机。还原错误：${originalDetail}；回滚错误：${rollbackDetail}`);
    this.name = 'BackupRollbackFailedError';
    this.originalError = originalError;
    this.rollbackError = rollbackError;
    this.snapshotUri = snapshotUri;
  }
}
