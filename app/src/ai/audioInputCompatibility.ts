import type { AiConnection } from './types';
import type { GiftOriginal } from '../gifts/giftTypes';

export type AudioInputAdapter = 'qwen-omni' | 'openai-input-audio';

// Qwen's documented Base64 limit is strictly below 10 MB. The generic adapter
// keeps the same client upload ceiling; selecting it does not certify a provider.
export const AUDIO_INPUT_BASE64_LIMIT = 10_000_000;

export function audioInputAdapterFor(connection: Pick<AiConnection, 'model'>): AudioInputAdapter {
  return /(?:^|\/)qwen[\d.]*-omni(?:-|$)/i.test(connection.model.trim())
    ? 'qwen-omni' : 'openai-input-audio';
}

const audioMimeFormats: Record<string, string> = {
  'audio/wav': 'wav', 'audio/wave': 'wav', 'audio/x-wav': 'wav', 'audio/vnd.wave': 'wav',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/x-mp3': 'mp3',
  'audio/aac': 'aac', 'audio/x-aac': 'aac', 'audio/amr': 'amr',
  'audio/3gpp': '3gp',
};

export function audioOriginalFormat(original: Pick<GiftOriginal, 'mimeType' | 'originalName'>,
  adapter: AudioInputAdapter): string {
  const mime = original.mimeType.toLowerCase().split(';')[0].trim();
  const extension = /\.([a-z0-9]+)$/i.exec(original.originalName)?.[1].toLowerCase();
  const mimeFormat = audioMimeFormats[mime];
  const format = mimeFormat === '3gp' && extension === '3gpp' ? extension
    : mimeFormat ?? (mime === 'application/octet-stream' ? extension : undefined);
  const supported = adapter === 'qwen-omni' ? ['wav', 'mp3', 'aac', 'amr', '3gp', '3gpp'] : ['wav', 'mp3'];
  if (!format || !supported.includes(format)
    || extension && supported.includes(extension) && extension !== format) throw Error('gift-audio-format-unsupported');
  return format;
}

export function assertAudioInputSize(byteSize: number) {
  if (!Number.isSafeInteger(byteSize) || byteSize < 1) throw Error('gift-original-missing');
  if (Math.ceil(byteSize / 3) * 4 >= AUDIO_INPUT_BASE64_LIMIT) throw Error('gift-audio-too-large');
}
