import { useRef, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import type { MessageImage } from '../ai/subjectiveMessages';
import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import { withManualCameraResource } from '../camera/cameraResourceArbiter';
import { registerImageFileCopy } from '../tools/fileToolStore';

type SendImageMessageInput = {
  duplicateKey: string;
  image: MessageImage;
  text: string;
};

export type UseChatImageSenderOptions = {
  getDraftText: () => string;
  onBeforeImageSend: () => void;
  onNotice: (message: string) => void;
  sendImageMessage: (input: SendImageMessageInput) => Promise<void>;
};

export function useChatImageSender(options: UseChatImageSenderOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [imageSending, setImageSending] = useState(false);
  const [imagePreviewUri, setImagePreviewUri] = useState<string | null>(null);

  const openImagePreview = (uri: string) => setImagePreviewUri(uri);
  const closeImagePreview = () => setImagePreviewUri(null);

  const pickAndSendImage = async (source: 'picker' | 'camera') => {
    if (imageSending) return;
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    const permission = source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      optionsRef.current.onNotice(source === 'camera' ? '需要相机权限才能拍照发送。' : '需要相册权限才能选图发送。');
      return;
    }

    setImageSending(true);
    try {
      const result = source === 'camera'
        ? await withManualCameraResource(() => ImagePicker.launchCameraAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
          quality: 0.9,
        }))
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsMultipleSelection: false, quality: 0.9 });
      const asset = result.canceled ? undefined : result.assets[0];
      if (!asset?.uri) return;
      const name = asset.fileName || (source === 'camera' ? 'junluo-camera.jpg' : 'junluo-image.jpg');
      const registered = await runBackupRestoreDataEpochCommit(dataEpoch, () => registerImageFileCopy({
          uri: asset.uri,
          name,
          mimeType: asset.mimeType ?? undefined,
          size: asset.fileSize,
          width: asset.width,
          height: asset.height,
          mediaSource: source,
        }));
      if (!registered.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      const record = registered.value;
      const image: MessageImage = {
        id: `message-image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        uri: record.uri,
        name: record.name,
        mimeType: record.mimeType,
        width: record.width,
        height: record.height,
        size: record.size,
        cacheId: record.cacheId,
        source,
        createdAt: Date.now(),
        visionStatus: 'pending',
      };
      const text = optionsRef.current.getDraftText();
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      optionsRef.current.onBeforeImageSend();
      await optionsRef.current.sendImageMessage({
        duplicateKey: `image:${image.id}:${text.trim()}`,
        image,
        text,
      });
    } catch (error) {
      optionsRef.current.onNotice(error instanceof Error ? error.message : '图片发送失败，请稍后再试。');
    } finally {
      setImageSending(false);
    }
  };

  return {
    closeImagePreview,
    imagePreviewUri,
    imageSending,
    openImagePreview,
    pickAndSendImage,
  };
}
