import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import JSZip from 'jszip';

import { writeStringFileSafely } from '../storage/safeFileWrite';
import {
  buildHeartCorpusJsonl,
  buildHeartCorpusMarkdown,
  sortHeartCorpusForExport,
  type ResolvedHeartCorpusRound,
} from './heartCorpus';

function pad(value: number) {
  return String(value).padStart(2, '0');
}

export function buildHeartCorpusArchiveFileName(now = new Date()) {
  return `junluo-heart-corpus-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.zip`;
}

export async function exportHeartCorpusArchive(
  rounds: readonly ResolvedHeartCorpusRound[],
) {
  if (!FileSystem.cacheDirectory) throw new Error('heart_corpus_cache_unavailable');
  const ordered = sortHeartCorpusForExport(rounds.filter((round) => round.exportable));
  const zip = new JSZip();
  zip.file('junluo-heart-corpus.md', buildHeartCorpusMarkdown(ordered));
  zip.file('junluo-heart-corpus.jsonl', buildHeartCorpusJsonl(ordered));
  const base64 = await zip.generateAsync({
    type: 'base64',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  const uri = `${FileSystem.cacheDirectory}${buildHeartCorpusArchiveFileName()}`;
  await writeStringFileSafely(uri, base64, {
    encoding: FileSystem.EncodingType.Base64,
    minimumBytes: 1,
  });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, {
      dialogTitle: '把爱心语料打包带走',
      mimeType: 'application/zip',
    });
  }
  return uri;
}
