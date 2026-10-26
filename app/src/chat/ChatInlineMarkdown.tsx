import type { ReactNode } from 'react';
import { StyleSheet, Text as NativeText, type TextStyle } from 'react-native';

type InlineMarkdownStyle = 'bold' | 'italic' | 'strike' | 'code';

const INLINE_MARKDOWN_MARKERS: Array<{ marker: string; style: InlineMarkdownStyle; recursive: boolean }> = [
  { marker: '`', style: 'code', recursive: false },
  { marker: '**', style: 'bold', recursive: true },
  { marker: '__', style: 'bold', recursive: true },
  { marker: '~~', style: 'strike', recursive: true },
  { marker: '*', style: 'italic', recursive: true },
  { marker: '_', style: 'italic', recursive: true },
];

function findNextMarkdownSpan(source: string, startAt: number) {
  let best: {
    contentEnd: number;
    contentStart: number;
    marker: string;
    markerStart: number;
    recursive: boolean;
    style: InlineMarkdownStyle;
  } | null = null;

  for (const definition of INLINE_MARKDOWN_MARKERS) {
    const markerStart = source.indexOf(definition.marker, startAt);
    if (markerStart < 0) continue;
    const contentStart = markerStart + definition.marker.length;
    const contentEnd = source.indexOf(definition.marker, contentStart);
    if (contentEnd <= contentStart) continue;
    if (best && markerStart >= best.markerStart) continue;
    best = {
      contentEnd,
      contentStart,
      marker: definition.marker,
      markerStart,
      recursive: definition.recursive,
      style: definition.style,
    };
  }

  return best;
}

export function renderInlineMarkdown(source: string, keyPrefix = 'md') {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let partIndex = 0;

  while (cursor < source.length) {
    const span = findNextMarkdownSpan(source, cursor);
    if (!span) {
      nodes.push(source.slice(cursor));
      break;
    }

    if (span.markerStart > cursor) nodes.push(source.slice(cursor, span.markerStart));
    const content = source.slice(span.contentStart, span.contentEnd);
    const childKey = `${keyPrefix}-${partIndex++}`;
    nodes.push(
      <NativeText key={childKey} style={inlineMarkdownTextStyles[span.style]}>
        {span.recursive ? renderInlineMarkdown(content, childKey) : content}
      </NativeText>,
    );
    cursor = span.contentEnd + span.marker.length;
  }

  return nodes;
}

const inlineMarkdownTextStyles = StyleSheet.create<Record<InlineMarkdownStyle, TextStyle>>({
  bold: {
    color: '#243244',
    fontWeight: '800',
  },
  italic: {
    fontStyle: 'italic',
  },
  strike: {
    opacity: 0.68,
    textDecorationLine: 'line-through',
  },
  code: {
    backgroundColor: 'rgba(255, 255, 255, 0.46)',
    borderRadius: 4,
    color: '#52677B',
    fontSize: 13.5,
  },
});
