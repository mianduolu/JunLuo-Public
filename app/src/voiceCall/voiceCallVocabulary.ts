import AsyncStorage from '@react-native-async-storage/async-storage';

import { loadBackendSettings } from '../backend/backendClient';
import { getVoiceCallApiToken } from './voiceCallSettings';

export type VoiceCallVocabulary = {
  words: string[];
  supported: boolean;
  modelReady: boolean;
  model: string;
};
type Draft = { words: string[]; pending: boolean };
const STORAGE_KEY = 'junluo.voiceCall.vocabulary.v1:';

export function normalizeVocabulary(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('词条最多 64 个。');
  const words = value.map((item: unknown) => {
    if (typeof item !== 'string') throw new Error('词表格式不正确。');
    const word = item.trim();
    if (!word || [...word].length > 24 || !/^[\p{L}\p{N}\p{M}·'’-]+$/u.test(word) || /^http/i.test(word)) {
      throw new Error('每个词条需为 1–24 字的名字或词语，可含字母、数字、间隔号或连字符。');
    }
    return word;
  });
  return [...new Set(words)];
}

export async function vocabularyBackendUrl(): Promise<string> {
  const { baseUrl } = await loadBackendSettings();
  const url = baseUrl.trim().replace(/\/+$/, '');
  if (!url) throw new Error('请先填写电脑后端地址。');
  return url;
}

export async function loadVocabularyDraft(baseUrl: string): Promise<Draft | null> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY + baseUrl);
  if (!raw) return null;
  const value = JSON.parse(raw) as Draft;
  return { words: normalizeVocabulary(value.words), pending: value.pending !== false };
}

async function requestVocabulary(baseUrl: string, words?: string[]): Promise<VoiceCallVocabulary> {
  const token = await getVoiceCallApiToken();
  if (!token) throw new Error('请先填写电话线访问令牌。');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${baseUrl}/api/voice-call/vocabulary`, {
      method: words === undefined ? 'GET' : 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: words === undefined ? undefined : JSON.stringify({ words }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(response.status === 401 ? '电话线令牌不匹配。'
        : response.status === 404 ? '电脑后端尚未更新私人词表功能。'
          : response.status === 409 ? '当前识别模型不支持热词，请更新并重启电脑后端。'
            : '电脑后端没有确认词表，请稍后重试。');
    }
    const data = await response.json() as VoiceCallVocabulary;
    if (typeof data.supported !== 'boolean' || typeof data.modelReady !== 'boolean' || typeof data.model !== 'string') {
      throw new Error('电脑后端返回的词表状态不完整。');
    }
    return { words: normalizeVocabulary(data.words), supported: data.supported, modelReady: data.modelReady, model: data.model };
  } catch (error) {
    if (error instanceof Error && /AbortError|TypeError/.test(error.name)) {
      throw new Error('暂时连不上电脑后端。');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchVocabulary(baseUrl: string): Promise<VoiceCallVocabulary> {
  const data = await requestVocabulary(baseUrl);
  const draft = await loadVocabularyDraft(baseUrl);
  if (!draft?.pending) {
    await AsyncStorage.setItem(STORAGE_KEY + baseUrl, JSON.stringify({ words: data.words, pending: false }));
  }
  return data;
}

export async function saveVocabulary(baseUrl: string, value: string[]): Promise<VoiceCallVocabulary> {
  const words = normalizeVocabulary(value);
  const key = STORAGE_KEY + baseUrl;
  await AsyncStorage.setItem(key, JSON.stringify({ words, pending: true }));
  const data = await requestVocabulary(baseUrl, words);
  if (!data.supported || JSON.stringify(data.words) !== JSON.stringify(words)) {
    throw new Error('电脑后端尚未确认这份词表。');
  }
  await AsyncStorage.setItem(key, JSON.stringify({ words, pending: false }));
  return data;
}

export function vocabularyStatus(data: VoiceCallVocabulary): string {
  if (!data.supported) return '当前模型不支持热词';
  return data.modelReady ? '已同步 · 后续识别生效' : '已同步 · 等待本地识别模型就绪';
}
