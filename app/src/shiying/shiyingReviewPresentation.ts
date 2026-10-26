/** Local reading models only: no model instructions or business identities. */
export type ShiyingReadingBlock = { kind: 'heading' | 'paragraph'; text: string };
export type ShiyingInlinePart = { text: string; strong: boolean };
export type ShiyingReadingRange = { start: number; end: number };

export function splitShiyingReviewTitle(factSummary: string) {
  const match = /^#\s+([^\r\n]+)(?:\r?\n|$)/u.exec(factSummary);
  return match ? { title: match[1].trim(), body: factSummary.slice(match[0].length).replace(/^\r?\n/u, '') }
    : { title: '周回顾', body: factSummary };
}

export function parseShiyingReadingBlocks(body: string): ShiyingReadingBlock[] {
  const blocks: ShiyingReadingBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
    paragraph = [];
  };
  for (const line of body.split(/\r?\n/u)) {
    const heading = /^#{1,6}\s+(.+)$/u.exec(line);
    if (heading) { flush(); blocks.push({ kind: 'heading', text: heading[1] }); }
    else if (!line.trim()) flush();
    else paragraph.push(line);
  }
  flush();
  return blocks;
}

export function parseShiyingReadingInline(text: string): ShiyingInlinePart[] {
  const parts: ShiyingInlinePart[] = [];
  const pattern = /\*\*([^*]+)\*\*/gu;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index;
    if (at > start) parts.push({ text: text.slice(start, at), strong: false });
    parts.push({ text: match[1], strong: true });
    start = at + match[0].length;
  }
  if (start < text.length) parts.push({ text: text.slice(start), strong: false });
  return parts;
}

export function getShiyingReviewReadingPalette(dark: boolean) {
  return dark ? { surface: '#202c3d', text: '#edece6', secondary: '#aebac7', divider: '#38475a', action: '#2b3b50', dot: '#b4c99e' }
    : { surface: '#f8fafb', text: '#303c40', secondary: '#66716f', divider: '#dce4e8', action: '#edf2f4', dot: '#8e9b79' };
}

export function shiyingReviewPeriodLabel(start: string, end: string) {
  const display = (value: string) => {
    const [year, month, day] = value.split('-').map(Number);
    return `${year}年${month}月${day}日`;
  };
  return `${display(start)} — ${display(end)}`;
}

export function isShiyingReadingRangeCurrent(range: ShiyingReadingRange, body: string) {
  const boundary = (at: number) => !(at > 0 && at < body.length
    && /[\uD800-\uDBFF]/u.test(body[at - 1]) && /[\uDC00-\uDFFF]/u.test(body[at]));
  return Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end)
    && range.start >= 0 && range.end > range.start && range.end <= body.length
    && boundary(range.start) && boundary(range.end);
}

export function getShiyingReadingHighlights(body: string, ranges: readonly ShiyingReadingRange[]) {
  const points = [...new Set([0, body.length, ...ranges.flatMap(range => [range.start, range.end])])].sort((a, b) => a - b);
  return points.slice(0, -1).map((start, index) => ({ start, text: body.slice(start, points[index + 1]),
    highlighted: ranges.some(range => range.start <= start && range.end >= points[index + 1]) }));
}

export function getShiyingDisplayedAutomaticCalls(state: { day: string | null; reservedCalls: number }, now = Date.now()) {
  const date = new Date(now);
  const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return state.day !== null && state.day >= today ? state.reservedCalls : 0;
}
