import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import { NativeModules } from 'react-native';
import { withManualCameraResource } from '../../camera/cameraResourceArbiter';
import { loadAiConfigPreferencesSnapshot } from '../../ai/AiConfigPreferences';
import {
  imageVisionFailedText,
  imageVisionSuccessText,
  imageVisionUnavailableText,
} from '../../ai/imageVisionMessages';
import { AiRequestError, describeImageWithVisionModel } from '../../ai/openAiCompatibleProvider';
import {
  getFileImportRecord,
  getSupportedImageFileExtensions,
  isSupportedImageFileName,
  registerImageFileCopy,
  type JunLuoFileImportRecord,
} from '../fileToolStore';
import { createToolError } from '../toolErrors';
import { createToolErrorResult, createToolSuccessResult } from '../toolResult';
import type { JunLuoToolCall, JunLuoToolDefinition, JunLuoToolExecutorContext, JunLuoToolPackage, JunLuoToolResult } from '../toolTypes';
import { readStringInput, validationFailed } from './builtinToolValidation';

type ImagePickerAsset = {
  uri?: string;
  fileName?: string | null;
  mimeType?: string | null;
  fileSize?: number;
  width?: number;
  height?: number;
};

type MediaImageData = {
  cacheId: string;
  name: string;
  mime?: string;
  size?: number;
  width?: number;
  height?: number;
  extension: string;
  uri: string;
};

type ImageDescribeData = {
  image: MediaImageData;
  descriptionStatus: 'metadata_only' | 'vision';
  description?: string;
  provider?: string;
};

function toMediaImageData(record: JunLuoFileImportRecord): MediaImageData {
  return {
    cacheId: record.cacheId,
    name: record.name,
    mime: record.mimeType,
    size: record.size,
    width: record.width,
    height: record.height,
    extension: record.extension,
    uri: record.uri,
  };
}

function unsupported<T>(call: JunLuoToolCall, summary: string, details?: unknown): JunLuoToolResult<T> {
  return createToolErrorResult<T>(
    call,
    createToolError('EXECUTION_FAILED', summary, { unsupported: true, ...((details && typeof details === 'object') ? details as Record<string, unknown> : {}) }),
    summary,
  );
}

function pickAsset(result: unknown): ImagePickerAsset | undefined {
  const payload = result as { canceled?: boolean; cancelled?: boolean; assets?: ImagePickerAsset[] } | undefined;
  if (!payload || payload.canceled || payload.cancelled) return undefined;
  return Array.isArray(payload.assets) ? payload.assets[0] : undefined;
}

function runToolDataCommit<T>(context: JunLuoToolExecutorContext | undefined, work: () => Promise<T> | T) {
  return context?.runBackupRestoreDataEpochCommit
    ? context.runBackupRestoreDataEpochCommit(work)
    : Promise.resolve(work());
}

async function launchImagePicker(
  call: JunLuoToolCall,
  source: 'picker' | 'camera',
  context?: JunLuoToolExecutorContext,
) {
  const ImagePicker = await import('expo-image-picker');
  const permission = source === 'camera'
    ? await ImagePicker.requestCameraPermissionsAsync()
    : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    return createToolErrorResult<MediaImageData>(
      call,
      createToolError('PERMISSION_DENIED', source === 'camera' ? '没有相机权限' : '没有相册权限', permission),
      source === 'camera' ? '没有拍照：相机权限未允许' : '没有选择图片：相册权限未允许',
    );
  }

  const result = source === 'camera'
    ? await withManualCameraResource(() => ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 1,
    }))
    : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsMultipleSelection: false, quality: 1 });
  const asset = pickAsset(result);
  if (!asset?.uri) {
    return createToolErrorResult<MediaImageData>(
      call,
      createToolError('EXECUTION_FAILED', source === 'camera' ? '用户取消了拍照' : '用户取消了选择图片'),
      source === 'camera' ? '没有拍照：已取消' : '没有选择图片：已取消',
    );
  }
  const assetUri = asset.uri;

  const name = asset.fileName || (source === 'camera' ? 'junluo-camera.jpg' : 'junluo-image.jpg');
  if (!isSupportedImageFileName(name)) {
    return validationFailed<MediaImageData>(call, `不支持的图片类型：${name}`, '没有保存图片：文件类型暂不支持');
  }

  const record = await runToolDataCommit(context, () => registerImageFileCopy({
    uri: assetUri,
    name,
    mimeType: asset.mimeType ?? undefined,
    size: asset.fileSize,
    width: asset.width,
    height: asset.height,
    mediaSource: source,
  }));
  const label = source === 'camera' ? '照片' : '图片';
  return createToolSuccessResult(call, `${label}已保存到君落缓存：${record.name}`, toMediaImageData(record));
}

async function executePickImage(call: JunLuoToolCall, context?: JunLuoToolExecutorContext) {
  try {
    return await launchImagePicker(call, 'picker', context);
  } catch (error) {
    return createToolErrorResult<MediaImageData>(
      call,
      createToolError('EXECUTION_FAILED', error instanceof Error ? error.message : String(error), error),
      '没有选择图片：图片选择工具执行失败',
    );
  }
}

async function executeOpenCamera(call: JunLuoToolCall, context?: JunLuoToolExecutorContext) {
  try {
    return await launchImagePicker(call, 'camera', context);
  } catch (error) {
    return createToolErrorResult<MediaImageData>(
      call,
      createToolError('EXECUTION_FAILED', error instanceof Error ? error.message : String(error), error),
      '没有拍照：相机工具执行失败',
    );
  }
}

async function executeTakeScreenshot(call: JunLuoToolCall, context?: JunLuoToolExecutorContext) {
  const captureModule = NativeModules?.JunLuoMediaCapture;
  if (!captureModule?.takeScreenshot) {
    return unsupported<MediaImageData>(call, '没有截图：当前安装包还没有像素截图原生能力', { code: 'NATIVE_UNAVAILABLE' });
  }
  try {
    const result = await captureModule.takeScreenshot();
    if (!result?.uri) {
      return unsupported<MediaImageData>(call, '没有截图：原生截图模块没有返回图片', { code: 'NATIVE_UNAVAILABLE', result });
    }
    const record = await runToolDataCommit(context, () => registerImageFileCopy({
      uri: result.uri,
      name: result.name || 'junluo-screenshot.png',
      mimeType: result.mimeType || 'image/png',
      size: result.size,
      width: result.width,
      height: result.height,
      mediaSource: 'generated',
    }));
    return createToolSuccessResult(call, `截图已保存到君落缓存：${record.name}`, toMediaImageData(record));
  } catch (error) {
    return createToolErrorResult<MediaImageData>(
      call,
      createToolError('EXECUTION_FAILED', error instanceof Error ? error.message : String(error), error),
      '没有截图：原生截图模块执行失败',
    );
  }
}

async function executeDescribeLocal(call: JunLuoToolCall, context?: JunLuoToolExecutorContext) {
  if (context?.chatImage) return context.chatImage(call);
  if (call.requestedBy === 'chat') return validationFailed(call, 'CHAT_IMAGE_HOST_REQUIRED', '这次没有取得图片观察结果。');
  const cacheId = readStringInput(call.input, 'cacheId');
  if (!cacheId) return validationFailed<ImageDescribeData>(call, 'cacheId 不能为空', '没有描述图片：缺少图片 cacheId');
  const record = await getFileImportRecord(cacheId);
  if (!record) return validationFailed<ImageDescribeData>(call, `图片缓存不存在：${cacheId}`, '没有描述图片：图片缓存不存在');
  if ((record.kind ?? '') !== 'image' && !isSupportedImageFileName(record.name)) {
    return validationFailed<ImageDescribeData>(call, `缓存文件不是图片：${record.name}`, '没有描述图片：这个 cacheId 不是图片');
  }

  const image = toMediaImageData(record);
  const snapshot = await loadAiConfigPreferencesSnapshot({ maxAgeMs: 0 });
  if (!snapshot.visionConnection || !snapshot.visionKey.trim()) {
    return createToolSuccessResult<ImageDescribeData>(
      call,
      imageVisionUnavailableText(record.name),
      {
        image,
        descriptionStatus: 'metadata_only',
      },
    );
  }

  try {
    const mimeType = record.mimeType || image.mime || 'image/jpeg';
    const base64 = await FileSystem.readAsStringAsync(record.uri, { encoding: 'base64' });
    const description = await describeImageWithVisionModel({
      apiKey: snapshot.visionKey,
      connection: snapshot.visionConnection,
      imageDataUrl: `data:${mimeType};base64,${base64}`,
      mimeType,
    });
    return createToolSuccessResult<ImageDescribeData>(
      call,
      imageVisionSuccessText(description),
      {
        description,
        descriptionStatus: 'vision',
        image,
        provider: `${snapshot.visionConnection.name} · ${snapshot.visionConnection.model}`,
      },
    );
  } catch (error) {
    const message = error instanceof AiRequestError || error instanceof Error
      ? error.message
      : '看图模型无法读取这张图片';
    return createToolErrorResult<ImageDescribeData>(
      call,
      createToolError('EXECUTION_FAILED', message, {
        cacheId,
        provider: `${snapshot.visionConnection.name} · ${snapshot.visionConnection.model}`,
      }),
      imageVisionFailedText(message),
    );
  }
}

function executeImageGenerate(call: JunLuoToolCall) {
  return unsupported(call, '没有生成图片：生图 provider 尚未接入', { status: 'unsupported' });
}

function executeVideoGenerate(call: JunLuoToolCall) {
  return unsupported(call, '没有生成视频：视频生成 provider 尚未接入', { status: 'unsupported' });
}

const mediaTools: JunLuoToolDefinition[] = [
  {
    id: 'media.pick_image',
    chatExposure: 'explicit_only',
    proactiveEligible: false,
    packageId: 'media',
    name: '选择图片',
    description: '从系统相册选择一张图片，并保存到君落工具缓存。',
    inputSchema: { type: 'object', properties: {} },
    permission: 'ask',
    riskLevel: 'read',
    readOnly: true,
    backupRestoreSafeOutsideLease: true,
    executor: executePickImage,
  },
  {
    id: 'media.open_camera',
    chatExposure: 'explicit_only',
    proactiveEligible: false,
    packageId: 'media',
    name: '拍照',
    description: '打开系统相机拍一张照片，并保存到君落工具缓存。',
    inputSchema: { type: 'object', properties: {} },
    permission: 'ask',
    riskLevel: 'device_control',
    readOnly: false,
    backupRestoreSafeOutsideLease: true,
    executor: executeOpenCamera,
  },
  {
    id: 'media.take_screenshot',
    chatExposure: 'explicit_only',
    proactiveEligible: false,
    packageId: 'media',
    name: '截屏',
    description: '尝试调用原生像素截图能力；没有原生模块时明确返回不可用。',
    inputSchema: { type: 'object', properties: {} },
    permission: 'ask',
    riskLevel: 'device_control',
    readOnly: true,
    backupRestoreSafeOutsideLease: true,
    executor: executeTakeScreenshot,
  },
];

const imageTools: JunLuoToolDefinition[] = [
  {
    id: 'image.describe_local',
    agentEpochMode: 'bounded_local_commits',
    agentSettlementDeadlineMs: 300_000,
    chatExposure: 'explicit_only',
    proactiveEligible: false,
    packageId: 'image',
    name: '描述本地图片',
    description: '读取君落缓存图片的信息；视觉 provider 未接入时只返回文件信息，不编造图像内容。',
    inputSchema: {
      type: 'object',
      properties: {
        cacheId: { type: 'string', description: '君落工具缓存里的图片 cacheId' },
      },
      required: ['cacheId'],
    },
    permission: 'ask',
    riskLevel: 'external_network',
    readOnly: false,
    backupRestoreSafeOutsideLease: true,
    executor: executeDescribeLocal,
  },
  {
    id: 'image.generate',
    chatExposure: 'disabled',
    proactiveEligible: false,
    packageId: 'image',
    name: '生成图片',
    description: '预留生图工具；当前没有接入 provider，会明确返回不可用。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '想生成的图片描述' },
      },
    },
    permission: 'ask',
    riskLevel: 'external_network',
    readOnly: false,
    executor: executeImageGenerate,
  },
];

const videoTools: JunLuoToolDefinition[] = [
  {
    id: 'video.generate',
    chatExposure: 'disabled',
    proactiveEligible: false,
    packageId: 'video',
    name: '生成视频',
    description: '预留视频生成工具；当前没有接入 provider，会明确返回不可用。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '想生成的视频描述' },
      },
    },
    permission: 'ask',
    riskLevel: 'external_network',
    readOnly: false,
    executor: executeVideoGenerate,
  },
];

export const mediaToolPackage: JunLuoToolPackage = {
  id: 'media',
  name: '媒体采集',
  description: `选择图片、拍照和截图能力。支持图片类型：${getSupportedImageFileExtensions().join(', ')}。`,
  category: 'media',
  source: 'builtin',
  defaultEnabled: true,
  riskLevel: 'device_control',
  tools: mediaTools,
};

export const imageToolPackage: JunLuoToolPackage = {
  id: 'image',
  name: '图片工具',
  description: '读取本地图片信息，并预留视觉描述和生图能力边界。',
  category: 'media',
  source: 'builtin',
  defaultEnabled: true,
  riskLevel: 'external_network',
  tools: imageTools,
};

export const videoToolPackage: JunLuoToolPackage = {
  id: 'video',
  name: '视频工具',
  description: '预留视频生成能力边界，当前不生成假视频。',
  category: 'media',
  source: 'builtin',
  defaultEnabled: true,
  riskLevel: 'external_network',
  tools: videoTools,
};


