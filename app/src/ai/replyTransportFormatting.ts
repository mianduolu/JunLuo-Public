// Only unwrap a complete, recognizable reply envelope, never arbitrary parentheses or code.
function readParenthesizedReply(content: string) {
  const raw = content.trim();
  const closing = raw.startsWith('(') ? ')' : raw.startsWith('（') ? '）' : undefined;
  if (!closing || !raw.endsWith(closing)) return undefined;
  const payload = raw.slice(1, -1).trim();
  if (!payload.startsWith('{')) return undefined;
  try {
    const value: unknown = JSON.parse(payload);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const messages = (value as { messages?: unknown }).messages;
    if (!Array.isArray(messages) || !messages.length
      || !messages.every((message): message is string => typeof message === 'string')) return undefined;
    return { payload, messages };
  } catch { return undefined; }
}

export function unwrapParenthesizedReplyEnvelope(content: string) {
  return readParenthesizedReply(content)?.payload ?? content;
}

function stripEchoedHistoryLabels(content: string, preserveEmpty = true) {
  if (!content.includes('消息序号')) return content;
  const lines = content.split('\n');
  const label = /^ {0,3}消息序号[ \t]+\d+[ \t]*[｜|][ \t]*发送时间[ \t]+\d{4}-\d{2}-\d{2}[ \t]+\d{2}:\d{2}[ \t]*\r?$/u;
  let fence: string | undefined;
  const labels: number[] = [];
  lines.forEach((line, index) => {
    const delimiter = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = undefined;
      return;
    }
    if (!fence && label.test(line)) labels.push(index);
  });
  // One label must lead the whole reply; repeated history labels may also follow a preface.
  if (!labels.length || (labels.length === 1 && lines.slice(0, labels[0]).some(line => line.trim()))) return content;
  const indexes = new Set(labels);
  const body = lines.filter((_, index) => !indexes.has(index)).join('\n').trim();
  return body || (preserveEmpty ? content : '');
}

/** A recognized transport label supplies no reply body on its own. */
export function isReplyOnlyHistoryLabels(content: string) {
  return content.trim().length > 0 && stripEchoedHistoryLabels(content, false) === '';
}

/** Formatting only: no rewriting, fallback sentences, tool execution or storage changes. */
export function cleanReplyTransportFormatting(content: string) {
  const wrapped = readParenthesizedReply(content);
  return stripEchoedHistoryLabels(wrapped ? wrapped.messages.join('\n\n') : content);
}
