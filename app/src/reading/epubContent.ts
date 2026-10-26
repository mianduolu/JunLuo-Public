import type { ReadingContentBlock } from './readingTypes';

export function decodeEpubEntities(value: string) {
  return value.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&#(\d+);|&#x([a-fA-F0-9]+);/g, (match, decimal: string, hex: string) => {
      const code = decimal ? Number(decimal) : parseInt(hex, 16);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    });
}

export function epubAttributes(raw: string) {
  const attributes: Record<string, string> = {};
  raw.replace(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (_match, key: string, double: string, single: string) => {
    attributes[key.toLowerCase()] = decodeEpubEntities(double ?? single);
    return '';
  });
  return attributes;
}

function plainText(value: string) {
  return decodeEpubEntities(value.replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|h[1-6]|blockquote|li|pre|section|figure)>/gi, '\n')
    .replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, ' '))
    .replace(/\r/g, '\n').replace(/[ \t\f\v]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export type ImageReference = { id: string; source: string; alt: string };
export type ParsedEpubContent = {
  paragraphs: string[];
  contentBlocks: ReadingContentBlock[];
  imageReferences: ImageReference[];
};

// Keep the existing outer paragraph/container identities. The ordered projection
// references slices of those paragraphs rather than copying text around images.
export function parseEpubContent(html: string): ParsedEpubContent {
  const body = (html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html)
    .replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  const units: string[] = [];
  const tags = /<(?:[^>"']|"[^"]*"|'[^']*')*>/g;
  let start = 0;
  let primaryTag: string | undefined;
  let depth = 0;
  for (const match of body.matchAll(tags)) {
    const tag = match[0].match(/^<\s*(\/?)\s*([\w:-]+)/);
    if (!tag) continue;
    const name = tag[2].toLowerCase();
    const closing = !!tag[1];
    if (!primaryTag && !closing && /^(p|div|h[1-6]|blockquote|li|pre|figure|section)$/.test(name)) {
      if (match.index! > start) units.push(body.slice(start, match.index));
      start = match.index!;
      primaryTag = name;
      depth = 1;
      if (/\/\s*>$/.test(match[0])) { units.push(match[0]); start += match[0].length; primaryTag = undefined; }
    } else if (name === primaryTag) {
      if (closing) depth -= 1;
      else if (!/\/\s*>$/.test(match[0])) depth += 1;
      if (!depth) {
        const end = match.index! + match[0].length;
        units.push(body.slice(start, end));
        start = end;
        primaryTag = undefined;
      }
    }
  }
  if (start < body.length) units.push(body.slice(start));

  const result: ParsedEpubContent = { paragraphs: [], contentBlocks: [], imageReferences: [] };
  for (const unit of units) {
    const text = plainText(unit);
    const paragraphIndex = result.paragraphs.length;
    if (text) result.paragraphs.push(text);
    let offset = 0;
    for (const tag of unit.matchAll(tags)) {
      if (!/^<\s*(?:[\w-]+:)?(?:img|image)\b/i.test(tag[0])) continue;
      const attrs = epubAttributes(tag[0]);
      const source = attrs.src || attrs['data-src'] || attrs['xlink:href'] || attrs.href;
      if (!source) throw new Error('epub-image-source-missing');
      const beforeImage = Math.min(text.length, plainText(unit.slice(0, tag.index)).length);
      if (beforeImage > offset) result.contentBlocks.push({ kind: 'text', paragraphIndex, startOffset: offset, endOffset: beforeImage });
      const id = `image-${result.imageReferences.length}`;
      result.imageReferences.push({ id, source, alt: attrs.alt ?? '' });
      result.contentBlocks.push({ kind: 'image', imageId: id });
      offset = beforeImage;
    }
    if (text.length > offset) result.contentBlocks.push({ kind: 'text', paragraphIndex, startOffset: offset, endOffset: text.length });
  }
  return result;
}
