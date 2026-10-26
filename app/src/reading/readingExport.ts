import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import { loadReadingBookResults } from './readingResults';
import type { ReadingResultItem, ReadingResultSection } from './readingResults';
import type { ReadingBook } from './readingTypes';

function safeFileName(value: string) {
  const cleaned = value.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || '共读笔记';
}

function escapeMarkdown(value: string) {
  return value.replace(/\r/g, '').trim();
}

function formatResultItem(item: ReadingResultItem) {
  const lines = [`- ${item.title} · ${item.positionLabel}`];
  if (item.sourceExcerpt) lines.push(`  - 原文：${escapeMarkdown(item.sourceExcerpt)}`);
  if (item.note?.question) lines.push(`  - 问：${escapeMarkdown(item.note.question)}`);
  if (item.text) lines.push(`  - 内容：${escapeMarkdown(item.text)}`);
  return lines.join('\n');
}

function appendGroup(lines: string[], title: string, items: ReadingResultItem[]) {
  if (!items.length) return;
  lines.push(`### ${title}`, '');
  items.forEach((item) => lines.push(formatResultItem(item)));
  lines.push('');
}

function appendSection(lines: string[], section: ReadingResultSection) {
  lines.push(`## 第 ${section.chapterIndex + 1} 章 · ${escapeMarkdown(section.chapterTitle)}`, '');
  appendGroup(lines, '白云读后感', section.summaries);
  appendGroup(lines, '白云批注', section.annotations);
  appendGroup(lines, '我的笔记', section.myNotes);
  appendGroup(lines, '问白云', section.questions);
}

export async function buildReadingBookMarkdown(book: ReadingBook) {
  const results = await loadReadingBookResults(book);
  const lines: string[] = [
    `# ${escapeMarkdown(book.title)} 共读笔记`,
    '',
    `- 作者：${escapeMarkdown(book.author)}`,
    `- 导入时间：${new Date(book.importedAt).toLocaleString('zh-CN')}`,
    `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
    `- 当前进度：第 ${book.currentChapter + 1} / ${book.totalChapters} 章`,
    `- 白云批注：${results.stats.annotations}`,
    `- 白云读后感：${results.stats.summaries}`,
    `- 我的笔记：${results.stats.myNotes}`,
    `- 问白云：${results.stats.questions}`,
    '',
  ];

  results.sections.forEach((section) => appendSection(lines, section));

  return lines.join('\n').replace(/\n{4,}/g, '\n\n\n');
}

export async function exportReadingBookMarkdown(book: ReadingBook) {
  if (!FileSystem.cacheDirectory) throw new Error('当前设备无法访问缓存目录。');
  const markdown = await buildReadingBookMarkdown(book);
  const uri = `${FileSystem.cacheDirectory}${safeFileName(book.title)}-共读笔记.md`;
  await FileSystem.writeAsStringAsync(uri, markdown, { encoding: FileSystem.EncodingType.UTF8 });
  try {
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(uri, {
        dialogTitle: `${book.title} 共读笔记`,
        mimeType: 'text/markdown',
      });
    }
  } catch {
    // The Markdown file has already been created; sharing failures should not turn export into data loss.
  }
  return uri;
}
