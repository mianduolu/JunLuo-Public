import {
  canEvictLocalSyncObject,
  type SyncObjectNetworkClass,
} from './syncObjectPolicy';

export type AndroidManagedObjectStatus =
  | 'pending-upload'
  | 'uploading'
  | 'upload-failed'
  | 'source-missing'
  | 'awaiting-confirmation'
  | 'downloading'
  | 'local'
  | 'evicted'
  | 'failed';

export type AndroidSyncObjectManagementRecord = {
  objectId: string;
  direction: 'upload' | 'download';
  state: 'pending' | 'running' | 'verified' | 'failed';
  pinned: boolean;
  localUri: string | null;
  lastErrorCode: string | null;
  totalChunks: number;
  completedChunks: number;
  unreferencedAt: number | null;
  localEvictedAt: number | null;
  liveReferenceCount: number;
  routes: readonly {
    domain: string;
    entityType: string;
  }[];
};

export type AndroidSyncObjectMetadata = {
  objectId: string;
  ciphertextBytes: number;
  domain?: string | null;
};

export type AndroidManagedObjectItem = {
  objectId: string;
  category: string;
  sizeBytes: number;
  status: AndroidManagedObjectStatus;
  completedChunks: number;
  totalChunks: number;
  pinned: boolean;
  actions: {
    canDownload: boolean;
    canPin: boolean;
    canUnpin: boolean;
    canEvict: boolean;
    canRedownload: boolean;
  };
};

export type AndroidObjectManagementSnapshot = {
  automaticDownloadEnabled: false;
  items: AndroidManagedObjectItem[];
};

type Inputs = {
  store: {
    listRecords(
      limit: number,
    ): Promise<AndroidSyncObjectManagementRecord[]>;
  };
  metadata: {
    list(): Promise<AndroidSyncObjectMetadata[]>;
  };
  download(
    objectId: string,
    input: {
      network: SyncObjectNetworkClass;
      requestedByUser: true;
    },
  ): Promise<unknown>;
  retention: {
    setPinned(objectId: string, pinned: boolean): Promise<unknown>;
    evictObject(objectId: string): Promise<unknown>;
  };
  localSize(localUri: string): Promise<number | null>;
  networkClass(): Promise<SyncObjectNetworkClass>;
  now?: () => number;
};

const CATEGORY_BY_LEGACY_ADAPTER_ID: Readonly<Record<string, string>> = {
  'chat.objects': '聊天附件',
  'persona.expression-objects': '表情与贴纸',
  'reading.objects': '共读文件',
  'together-walked.life': '一起走过',
  'tools.workspace': '工具文件',
  'appearance.fonts': '字体',
  'appearance.background': '背景',
  'research.materials': '研究材料',
};

const CATEGORY_BY_REMEMBERED_DOMAIN: Readonly<Record<string, string>> = {
  chat: '聊天附件',
  persona: '表情与贴纸',
  reading: '共读文件',
  'together-walked': '一起走过',
  tools: '工具文件',
  appearance: '外观文件',
  research: '研究材料',
};

function categoryForRoute(route: {
  domain: string;
  entityType: string;
}) {
  if (
    route.domain === 'chat'
    && route.entityType === 'attachment-metadata'
  ) return '聊天附件';
  if (
    route.domain === 'persona'
    && route.entityType === 'sticker'
  ) return '表情与贴纸';
  if (
    route.domain === 'reading'
    && (
      route.entityType === 'book-object'
      || route.entityType === 'cover-object'
      || route.entityType === 'extracted-image-object'
    )
  ) return '共读文件';
  if (route.domain === 'together-walked') return '一起走过';
  if (
    route.domain === 'tools'
    && route.entityType === 'file-object'
  ) return '工具文件';
  if (
    route.domain === 'appearance'
    && (
      route.entityType === 'font-choice'
      || route.entityType === 'font-object'
    )
  ) return '字体';
  if (
    route.domain === 'appearance'
    && (
      route.entityType === 'background-settings'
      || route.entityType === 'background-object'
    )
  ) return '背景';
  if (route.domain === 'research') return '研究材料';
  return null;
}

function assertObjectId(value: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error('objectId 必须是 32 bytes 无填充 base64url。');
  }
}

function categoryFor(
  routes: AndroidSyncObjectManagementRecord['routes'],
  rememberedDomain?: string | null,
) {
  for (const route of routes) {
    const category = categoryForRoute(route);
    if (category) return category;
  }
  if (rememberedDomain) {
    return CATEGORY_BY_REMEMBERED_DOMAIN[rememberedDomain]
      ?? CATEGORY_BY_LEGACY_ADAPTER_ID[rememberedDomain]
      ?? '其他文件';
  }
  return '其他文件';
}

function statusFor(
  record: AndroidSyncObjectManagementRecord,
): AndroidManagedObjectStatus {
  if (record.localEvictedAt !== null) return 'evicted';
  if (record.direction === 'upload') {
    if (record.lastErrorCode === 'object.source-missing') {
      return 'source-missing';
    }
    if (record.state === 'failed' || !record.localUri) return 'upload-failed';
    if (record.state === 'running') return 'uploading';
    if (record.state === 'verified') return 'local';
    return 'pending-upload';
  }
  if (record.state === 'failed') return 'failed';
  if (record.state === 'running') return 'downloading';
  if (record.state === 'verified' && record.localUri) return 'local';
  return 'awaiting-confirmation';
}

export class AndroidSyncObjectManagementController {
  private readonly now: () => number;

  constructor(private readonly input: Inputs) {
    this.now = input.now ?? Date.now;
  }

  async snapshot(): Promise<AndroidObjectManagementSnapshot> {
    const [records, metadataEntries] = await Promise.all([
      this.input.store.listRecords(256),
      this.input.metadata.list(),
    ]);
    const metadata = new Map(
      metadataEntries.map((entry) => [entry.objectId, entry]),
    );
    const items: AndroidManagedObjectItem[] = [];
    for (const record of [...records].sort(
      (left, right) => left.objectId.localeCompare(right.objectId),
    )) {
      const knownSize = metadata.get(record.objectId)?.ciphertextBytes;
      const localSize = record.localUri
        ? await this.input.localSize(record.localUri)
        : null;
      const sizeBytes = knownSize ?? localSize;
      if (!Number.isFinite(sizeBytes) || sizeBytes! < 0) continue;
      const status = statusFor(record);
      items.push({
        objectId: record.objectId,
        category: categoryFor(
          record.routes,
          metadata.get(record.objectId)?.domain,
        ),
        sizeBytes: Math.floor(sizeBytes!),
        status,
        completedChunks: record.completedChunks,
        totalChunks: record.totalChunks,
        pinned: record.pinned,
        actions: {
          canDownload: status === 'awaiting-confirmation',
          canPin: status === 'local' && !record.pinned,
          canUnpin: status === 'local' && record.pinned,
          canEvict: !!record.localUri
            && canEvictLocalSyncObject({
              pinned: record.pinned,
              remoteVerified: record.state === 'verified',
              liveReferenceCount: record.liveReferenceCount,
              unreferencedAt: record.unreferencedAt,
              now: this.now(),
            }),
          canRedownload: status === 'failed' || status === 'evicted',
        },
      });
    }
    return { automaticDownloadEnabled: false, items };
  }

  async download(objectId: string) {
    assertObjectId(objectId);
    await this.input.download(objectId, {
      network: await this.input.networkClass(),
      requestedByUser: true,
    });
    return this.snapshot();
  }

  async pin(objectId: string) {
    assertObjectId(objectId);
    await this.input.retention.setPinned(objectId, true);
    return this.snapshot();
  }

  async unpin(objectId: string) {
    assertObjectId(objectId);
    await this.input.retention.setPinned(objectId, false);
    return this.snapshot();
  }

  async evict(objectId: string) {
    assertObjectId(objectId);
    await this.input.retention.evictObject(objectId);
    return this.snapshot();
  }
}
