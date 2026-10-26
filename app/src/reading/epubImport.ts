import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { copyFileSafely, writeStringFileSafely } from '../storage/safeFileWrite';
import JSZip from 'jszip';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';

import {
  deleteReadingBookRecord,
  getReadingBookDirectory,
  makeReadingId,
  saveReadingChapter,
  upsertReadingBook,
} from './readingStore';
import type { ReadingBook, ReadingChapter, ReadingContentBlock, ReadingImage } from './readingTypes';
import { parseEpubContent } from './epubContent';
import { computeOrderedReadingSegments } from './readingContent';
import type { EpubSourceChapter } from './readingEpubUpgrade';

type ManifestItem = {
  href: string;
  id: string;
  mediaType: string;
  properties?: string;
};

type OpfPackage = {
  author: string;
  language?: string;
  manifest: Map<string, ManifestItem>;
  opfDir: string;
  spine: string[];
  title: string;
};

type ParsedEpub = {
  author: string;
  chapters: ReadingChapter[];
  coverBase64?: string;
  coverExtension?: string;
  language?: string;
  title: string;
};

type EpubImportOptions = {
  runDataEpochCommit?: <T>(work: () => Promise<T> | T) => Promise<T>;
  decodeImage?: (base64: string, sourcePath: string) => Promise<{ width: number; height: number }>;
};

type ChapterBlocks = {
  htmlContent: string;
  paragraphs: string[];
  contentBlocks: ReadingContentBlock[];
  images: ReadingImage[];
};

function decodeEntities(value: string) {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-fA-F0-9]+);/g, (_match, code: string) => String.fromCodePoint(parseInt(code, 16)));
}

function normalizeText(value: string) {
  return decodeEntities(value)
    .replace(/\r/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function htmlEscape(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stripQueryHash(path: string) {
  return decodeEntities(path).split('#')[0].split('?')[0];
}

function stripHtml(value: string) {
  return normalizeText(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|h[1-6]|blockquote|li|pre|section|figure)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  );
}

function extractTag(xml: string, tag: string) {
  const escaped = tag.replace(':', '\\:');
  const match = xml.match(new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
  return match ? stripHtml(match[1]) : '';
}

function readAttributes(raw: string) {
  const attrs: Record<string, string> = {};
  raw.replace(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (_match, key: string, double: string, single: string) => {
    attrs[key] = decodeEntities(double ?? single);
    return '';
  });
  return attrs;
}

function dirname(path: string) {
  const slashIndex = path.lastIndexOf('/');
  return slashIndex >= 0 ? path.slice(0, slashIndex + 1) : '';
}

function basename(path: string) {
  const clean = stripQueryHash(path).replace(/\\/g, '/');
  const slashIndex = clean.lastIndexOf('/');
  return slashIndex >= 0 ? clean.slice(slashIndex + 1) : clean;
}

function resolveEpubPath(baseDir: string, href: string) {
  let cleanHref = stripQueryHash(href).replace(/\\/g, '/');
  try { cleanHref = decodeURIComponent(cleanHref); } catch { /* A literal percent in a ZIP path remains literal. */ }
  if (!cleanHref) return '';
  if (/^[a-z]+:/i.test(cleanHref)) return '';
  const parts = `${cleanHref.startsWith('/') ? '' : baseDir}${cleanHref}`.split('/');
  const normalized: string[] = [];
  parts.forEach((part) => {
    if (!part || part === '.') return;
    if (part === '..') {
      normalized.pop();
    } else {
      normalized.push(part);
    }
  });
  return normalized.join('/');
}

function parseManifest(opf: string) {
  const items = new Map<string, ManifestItem>();
  opf.replace(/<item\b([^>]*)\/?>/gi, (_match, rawAttrs: string) => {
    const attrs = readAttributes(rawAttrs);
    if (attrs.id && attrs.href) {
      items.set(attrs.id, {
        href: attrs.href,
        id: attrs.id,
        mediaType: attrs['media-type'] ?? '',
        properties: attrs.properties,
      });
    }
    return '';
  });
  return items;
}

function parseSpine(opf: string) {
  const idRefs: string[] = [];
  const spineBody = opf.match(/<spine\b[^>]*>([\s\S]*?)<\/spine>/i)?.[1] ?? '';
  spineBody.replace(/<itemref\b([^>]*)\/?>/gi, (_match, rawAttrs: string) => {
    const attrs = readAttributes(rawAttrs);
    if (attrs.idref) idRefs.push(attrs.idref);
    return '';
  });
  return idRefs;
}

async function readEpubContainer(zip: JSZip) {
  const container = await zip.file('META-INF/container.xml')?.async('text');
  if (!container) throw new Error('这本 EPUB 缺少目录文件，暂时读不了。');
  const rootfile = container.match(/\bfull-path\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
  const rootfilePath = rootfile?.[1] ?? rootfile?.[2];
  if (!rootfilePath) throw new Error('这本 EPUB 的目录文件里没有找到 OPF 路径。');
  return rootfilePath;
}

function parseOpfPackage(opf: string, rootfilePath: string): OpfPackage {
  const manifest = parseManifest(opf);
  const spine = parseSpine(opf);
  if (!spine.length) throw new Error('这本 EPUB 没有可用的阅读顺序。');
  return {
    author: extractTag(opf, 'dc:creator') || extractTag(opf, 'creator') || '佚名',
    language: extractTag(opf, 'dc:language') || extractTag(opf, 'language') || undefined,
    manifest,
    opfDir: dirname(rootfilePath),
    spine,
    title: extractTag(opf, 'dc:title') || extractTag(opf, 'title') || '未命名的书',
  };
}

function extensionFromPath(path: string, mediaType?: string) {
  const match = stripQueryHash(path).match(/\.([a-zA-Z0-9]{1,8})$/);
  if (match) return match[1].toLowerCase();
  if (mediaType === 'image/png') return 'png';
  if (mediaType === 'image/webp') return 'webp';
  if (mediaType === 'image/gif') return 'gif';
  return 'jpg';
}

function findCoverItem(opf: string, manifest: Map<string, ManifestItem>) {
  const coverMeta = opf.match(/<meta\b[^>]*name=["']cover["'][^>]*content=["']([^"']+)["'][^>]*\/?>/i);
  if (coverMeta) {
    const item = manifest.get(decodeEntities(coverMeta[1]));
    if (item) return item;
  }

  for (const item of manifest.values()) {
    if (item.properties?.split(/\s+/).includes('cover-image')) return item;
  }

  for (const item of manifest.values()) {
    if (item.mediaType.startsWith('image/') && /cover|封面/i.test(`${item.id} ${item.href}`)) return item;
  }

  return undefined;
}

async function extractEpubCover(zip: JSZip, opf: string, opfPackage: OpfPackage) {
  const coverItem = findCoverItem(opf, opfPackage.manifest);
  if (coverItem && !zip.file(resolveEpubPath(opfPackage.opfDir, coverItem.href))) {
    throw new Error('epub-cover-file-missing');
  }
  const coverCandidates = coverItem
    ? [resolveEpubPath(opfPackage.opfDir, coverItem.href)]
    : [];
  [
    'cover.jpg',
    'cover.jpeg',
    'cover.png',
    'images/cover.jpg',
    'images/cover.jpeg',
    'images/cover.png',
    'OEBPS/cover.jpg',
    'OEBPS/cover.jpeg',
    'OEBPS/cover.png',
    'OEBPS/images/cover.jpg',
    'OEBPS/images/cover.jpeg',
    'OEBPS/images/cover.png',
  ].forEach((path) => coverCandidates.push(path));

  for (const path of Array.from(new Set(coverCandidates.filter(Boolean)))) {
    const file = zip.file(path);
    if (file) {
      return {
        coverBase64: await file.async('base64'),
        coverExtension: extensionFromPath(path, coverItem?.mediaType),
      };
    }
  }

  return {};
}

async function extractTocTitles(zip: JSZip, opfPackage: OpfPackage) {
  const titles = new Map<string, string>();
  const navItem = Array.from(opfPackage.manifest.values()).find((item) =>
    item.properties?.split(/\s+/).includes('nav') || /nav|toc/i.test(`${item.id} ${item.href}`),
  );
  if (!navItem) return titles;
  const navPath = resolveEpubPath(opfPackage.opfDir, navItem.href);
  const navHtml = await zip.file(navPath)?.async('text').catch(() => undefined);
  if (!navHtml) return titles;
  navHtml.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_match, rawAttrs: string, body: string) => {
    const attrs = readAttributes(rawAttrs);
    if (!attrs.href) return '';
    const target = resolveEpubPath(dirname(navPath), attrs.href);
    const title = stripHtml(body);
    if (target && title) titles.set(target, title);
    return '';
  });
  return titles;
}

async function decodeChapterImage(base64: string): Promise<{ width: number; height: number }> {
  const { Skia } = await import('@shopify/react-native-skia');
  const data = Skia.Data.fromBase64(base64);
  try {
    const image = Skia.Image.MakeImageFromEncoded(data);
    if (!image) throw new Error('epub-image-decode-failed');
    try { return { width: image.width(), height: image.height() }; }
    finally { image.dispose(); }
  } finally { data.dispose(); }
}

async function saveChapterImage(
  zip: JSZip,
  bookDirectory: string,
  chapterPath: string,
  src: string,
  savedImages: Map<string, ReadingImage>,
  decodeImage: NonNullable<EpubImportOptions['decodeImage']>,
): Promise<ReadingImage> {
  const imagePath = resolveEpubPath(dirname(chapterPath), src);
  if (!imagePath) throw new Error('epub-image-reference-invalid');
  const saved = savedImages.get(imagePath);
  if (saved) return saved;
  const file = zip.file(imagePath);
  if (!file) throw new Error('epub-image-file-missing');
  const imageDirectory = `${bookDirectory}images/`;
  const extension = extensionFromPath(imagePath);
  const fileName = `${bytesToHex(sha256(new TextEncoder().encode(imagePath)))}.${extension}`;
  const uri = `${imageDirectory}${fileName}`;
  const imageBase64 = await file.async('base64');
  const dimensions = await decodeImage(imageBase64, imagePath);
  if (![dimensions.width, dimensions.height].every(value => Number.isFinite(value) && value >= 1)) {
    throw new Error('epub-image-decode-failed');
  }
  const contentVersion = bytesToHex(sha256(await file.async('uint8array')));
  await writeStringFileSafely(uri, imageBase64, { encoding: FileSystem.EncodingType.Base64 });
  const image: ReadingImage = { id: `epub:${imagePath}`, sourcePath: imagePath, uri, contentVersion, ...dimensions };
  savedImages.set(imagePath, image);
  return image;
}

async function extractChapterBlocks(
  zip: JSZip, bookDirectory: string, chapterPath: string, html: string,
  savedImages: Map<string, ReadingImage>, decodeImage: NonNullable<EpubImportOptions['decodeImage']>,
): Promise<ChapterBlocks> {
  const parsed = parseEpubContent(html);
  const images = new Map<string, ReadingImage>();
  const contentBlocks: ReadingContentBlock[] = [];
  for (const block of parsed.contentBlocks) {
    if (block.kind === 'text') {
      contentBlocks.push(block);
    } else {
      const reference = parsed.imageReferences.find(image => image.id === block.imageId)!;
      const image = await saveChapterImage(zip, bookDirectory, chapterPath, reference.source, savedImages, decodeImage);
      images.set(image.id, image);
      contentBlocks.push({ kind: 'image', imageId: image.id });
    }
  }
  const storedImages = [...images.values()];
  const references = parsed.imageReferences.map(reference => ({ ...reference,
    id: `epub:${resolveEpubPath(dirname(chapterPath), reference.source)}` }));
  return { htmlContent: renderEpubChapterHtml(parsed.paragraphs, contentBlocks, storedImages, references),
    paragraphs: parsed.paragraphs, contentBlocks, images: storedImages };
}

/** Existing reader projection; data-p remains the original annotation paragraph identity. */
export function renderEpubChapterHtml(paragraphs: string[], blocks: ReadingContentBlock[], images: ReadingImage[],
  references: Array<{ id: string; alt: string }> = []) {
  return blocks.map(block => {
    if (block.kind === 'text') return `<p data-p="${block.paragraphIndex}">${htmlEscape(paragraphs[block.paragraphIndex].slice(block.startOffset, block.endOffset))}</p>`;
    const image = images.find(item => item.id === block.imageId);
    if (!image) throw new Error('epub-image-file-missing');
    const alt = references.find(item => item.id === block.imageId)?.alt ?? '';
    return `<div class="book-img"><img src="${htmlEscape(image.uri)}" alt="${htmlEscape(alt)}" loading="lazy"></div>`;
  }).join('\n');
}

function extractChapterTitle(html: string, fallback: string) {
  const title =
    html.match(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i)?.[1] ??
    html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ??
    '';
  return stripHtml(title) || fallback;
}

async function loadEpubZip(sourceUri: string) {
  try {
    const epubBase64 = await FileSystem.readAsStringAsync(sourceUri, { encoding: FileSystem.EncodingType.Base64 });
    return await JSZip.loadAsync(epubBase64, { base64: true, checkCRC32: true });
  } catch {
    throw new Error('这不是一本可以读取的 EPUB 文件。');
  }
}

/** Replay the old paragraph extraction only for exact identity checks, never for new imports. */
function legacyEpubParagraphs(html: string) {
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  const matches = Array.from(body.matchAll(/<(p|div|h[1-6]|blockquote|li|pre|figure|section)\b[^>]*>[\s\S]*?<\/\1>/gi));
  const paragraphs = (matches.length ? matches.map(match => match[0]) : [body]).map(stripHtml).filter(text => text.length > 1);
  if (paragraphs.length) return paragraphs;
  const text = stripHtml(body);
  const lines = text.split(/\n{2,}|\n/).map(normalizeText).filter(item => item.length > 1);
  return lines.length > 1 ? lines : text.split(/(?<=[。！？.!?])\s+/).map(normalizeText).filter(item => item.length > 1);
}

/** Read the saved original without changing its book, files, notes or reading clock. */
export async function readEpubSourceChapters(sourceUri: string): Promise<EpubSourceChapter[]> {
  const zip = await loadEpubZip(sourceUri);
  const root = await readEpubContainer(zip);
  const opf = await zip.file(root)?.async('text');
  if (!opf) throw new Error('epub-package-missing');
  const metadata = parseOpfPackage(opf, root);
  const titles = await extractTocTitles(zip, metadata);
  const chapters: EpubSourceChapter[] = [];
  for (const [spineIndex, id] of metadata.spine.entries()) {
    const item = metadata.manifest.get(id);
    if (!item || !/xhtml|html/i.test(item.mediaType)) throw new Error('epub-spine-item-unreadable');
    const sourcePath = resolveEpubPath(metadata.opfDir, item.href);
    if (!sourcePath) throw new Error('epub-chapter-reference-invalid');
    const html = await zip.file(sourcePath)?.async('text');
    if (html === undefined) throw new Error('epub-chapter-file-missing');
    const parsed = parseEpubContent(html);
    const imageReferences = parsed.imageReferences.map(reference => {
      const path = resolveEpubPath(dirname(sourcePath), reference.source);
      if (!path) throw new Error('epub-image-reference-invalid');
      if (!zip.file(path)) throw new Error('epub-image-file-missing');
      return { ...reference, id: `epub:${path}`, source: path };
    });
    const ids = new Map(parsed.imageReferences.map((reference, index) => [reference.id, imageReferences[index].id]));
    chapters.push({ sourcePath, sourceVersion: bytesToHex(sha256(new TextEncoder().encode(html))), spineIndex,
      title: titles.get(sourcePath) || extractChapterTitle(html, ''),
      legacyParagraphs: legacyEpubParagraphs(html), paragraphs: parsed.paragraphs,
      contentBlocks: parsed.contentBlocks.map(block => block.kind === 'image' ? { ...block, imageId: ids.get(block.imageId)! } : block),
      imageReferences });
  }
  return chapters;
}

/** Extract only the confirmed chapter's originals; caller owns epoch and chapter commit. */
export async function prepareEpubSourceImages(sourceUri: string, bookDirectory: string,
  source: EpubSourceChapter, options: Pick<EpubImportOptions, 'decodeImage'> = {}): Promise<ReadingImage[]> {
  const zip = await loadEpubZip(sourceUri);
  const html = await zip.file(source.sourcePath)?.async('text');
  if (html === undefined || bytesToHex(sha256(new TextEncoder().encode(html))) !== source.sourceVersion) {
    throw new Error('epub-upgrade-source-changed');
  }
  const saved = new Map<string, ReadingImage>();
  for (const reference of source.imageReferences) {
    // Discovery already resolved this to a ZIP-root path. Reuse the importer codec and file naming.
    await saveChapterImage(zip, bookDirectory, '', reference.source, saved, options.decodeImage ?? decodeChapterImage);
  }
  return [...saved.values()];
}

async function parseEpubFile(bookId: string, sourceUri: string, bookDirectory: string, options: EpubImportOptions): Promise<ParsedEpub> {
  const zip = await loadEpubZip(sourceUri);
  const rootfilePath = await readEpubContainer(zip);
  const opf = await zip.file(rootfilePath)?.async('text');
  if (!opf) throw new Error('这本 EPUB 缺少书籍元数据，暂时读不了。');

  const opfPackage = parseOpfPackage(opf, rootfilePath);
  const cover = await extractEpubCover(zip, opf, opfPackage);
  const tocTitles = await extractTocTitles(zip, opfPackage);
  const decodeImage = options.decodeImage ?? decodeChapterImage;
  if (cover.coverBase64) await decodeImage(cover.coverBase64, 'cover');

  const chapters: ReadingChapter[] = [];
  const savedImages = new Map<string, ReadingImage>();
  for (const idRef of opfPackage.spine) {
    const item = opfPackage.manifest.get(idRef);
    if (!item || !/xhtml|html/i.test(item.mediaType)) throw new Error('epub-spine-item-unreadable');
    const chapterPath = resolveEpubPath(opfPackage.opfDir, item.href);
    if (!chapterPath) throw new Error('epub-chapter-reference-invalid');
    const html = await zip.file(chapterPath)?.async('text');
    if (html === undefined) throw new Error('epub-chapter-file-missing');
    const blocks = await extractChapterBlocks(zip, bookDirectory, chapterPath, html, savedImages, decodeImage);
    if (!blocks.contentBlocks.length) continue;
    const index = chapters.length;
    const textContent = blocks.paragraphs.join('\n\n');
    const chapter: ReadingChapter = {
      bookId,
      index,
      title: tocTitles.get(chapterPath) || extractChapterTitle(html, `第 ${index + 1} 章`),
      htmlContent: blocks.htmlContent,
      textContent,
      paragraphs: blocks.paragraphs,
      contentBlocks: blocks.contentBlocks,
      images: blocks.images,
      charCount: textContent.length,
      segmentsMeta: [],
    };
    chapter.segmentsMeta = computeOrderedReadingSegments(chapter);
    chapters.push(chapter);
  }

  if (!chapters.length) throw new Error('这本 EPUB 没有解析出可阅读章节，可能是加密、固定版式或结构异常。');
  return {
    author: opfPackage.author,
    chapters,
    coverBase64: cover.coverBase64,
    coverExtension: cover.coverExtension,
    language: opfPackage.language,
    title: opfPackage.title,
  };
}

export async function importEpubBook() {
  const result = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
    multiple: false,
    type: ['application/epub+zip', 'application/octet-stream'],
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset?.uri) return null;

  return importEpubBookFromUri({
    name: asset.name,
    size: asset.size,
    uri: asset.uri,
  });
}

export async function importEpubBookFromUri(
  asset: { name?: string; size?: number; uri: string },
  options: EpubImportOptions = {},
) {
  const dataEpoch = captureBackupRestoreDataEpoch();
  if (!options.runDataEpochCommit && dataEpoch === null) throw new Error('backup-restore-not-ready');
  const runImportCommit = options.runDataEpochCommit ?? (async <T>(work: () => Promise<T> | T) => {
    const committed = await runBackupRestoreDataEpochCommit(dataEpoch, () => Promise.resolve(work()));
    if (!committed.committed) throw new Error('backup-restore-data-epoch-changed');
    return committed.value;
  });
  const bookId = makeReadingId('book');
  const bookDirectory = getReadingBookDirectory(bookId);
  let publicationAttempted = false;
  try {
    await FileSystem.makeDirectoryAsync(bookDirectory, { intermediates: true });
    const sourceUri = `${bookDirectory}source.epub`;
    await copyFileSafely({ from: asset.uri, to: sourceUri });

    const parsed = await parseEpubFile(bookId, sourceUri, bookDirectory, options);
    let coverUri: string | undefined;
    if (parsed.coverBase64 && parsed.coverExtension) {
      coverUri = `${bookDirectory}cover.${parsed.coverExtension}`;
      await writeStringFileSafely(coverUri, parsed.coverBase64, { encoding: FileSystem.EncodingType.Base64 });
    }

    const book: ReadingBook = {
      id: bookId,
      title: parsed.title,
      author: parsed.author,
      language: parsed.language,
      fileType: 'epub',
      fileUri: sourceUri,
      coverUri,
      totalChapters: parsed.chapters.length,
      currentChapter: 0,
      currentParagraph: 0,
      progressFraction: 0,
      importedAt: Date.now(),
      lastOpenedAt: Date.now(),
    };
    const committedBook = await runImportCommit(async () => {
      const chapterResults = await Promise.allSettled(parsed.chapters.map(saveReadingChapter));
      const failed = chapterResults.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed) throw failed.reason;
      publicationAttempted = true;
      await upsertReadingBook(book);
      return book;
    });
    if (
      !options.runDataEpochCommit
      && !canCommitBackupRestoreDataEpoch(dataEpoch)
    ) throw new Error('backup-restore-data-epoch-changed');
    return committedBook;
  } catch (error) {
    const cleaned = !publicationAttempted && await deleteReadingBookRecord(bookId, {
      unpublishedImportEpoch: dataEpoch,
    }).catch(() => false);
    if (!cleaned) {
      console.warn('[reading-import] cleanup-unknown', { bookId,
        reason: publicationAttempted ? 'publication-attempted' : 'cleanup-not-confirmed' });
    }
    throw error;
  }
}

