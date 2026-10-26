import { stableMemoryHash } from '../memory/memoryAtomicity';
import { loadLetters, type LetterEntry } from './letterStore';

export type LetterMemoryPart = {
  letterId: string;
  part: 'original' | 'reply';
  sessionId: string;
  messageId: string;
  role: 'I' | 'you';
  createdAt: number;
  availableAt: number;
  title: string;
  content: string;
  label: '原信' | '回信' | '未来信';
  sourceHash: string;
};

export type LetterMemoryOriginalReader = (letterId: string) => Promise<LetterEntry | null>;
let originalReader: LetterMemoryOriginalReader | null = null;
/** Desktop may read its existing materialized original; App keeps its saved-letter reader. */
export function bindLetterMemoryOriginalReader(reader: LetterMemoryOriginalReader | null) { originalReader = reader; }

export function getLetterContextMessageId(letterId: string, part: 'original' | 'reply') {
  return `letter-${letterId}-${part}`;
}

export function getLetterMemoryParts(letter: LetterEntry): LetterMemoryPart[] {
  const parts: LetterMemoryPart[] = [];
  const add = (part: 'original' | 'reply', role: 'I' | 'you', content: string | undefined,
    createdAt: number | undefined, availableAt: number | undefined, label: LetterMemoryPart['label']) => {
    if (!content?.trim() || createdAt === undefined || !Number.isFinite(createdAt)
      || availableAt === undefined || !Number.isFinite(availableAt)) return;
    parts.push({ letterId: letter.id, part, sessionId: `letter:${letter.id}`,
      messageId: getLetterContextMessageId(letter.id, part), role, createdAt, availableAt,
      title: letter.title, content, label,
      sourceHash: stableMemoryHash(JSON.stringify([letter.title, part, role, createdAt, content])),
    });
  };
  if (letter.kind === 'future-self') {
    add('original', 'I', letter.content, letter.createdAt, letter.openedAt, '未来信');
  } else {
    add('original', letter.direction === 'you-to-ai' ? 'you' : 'I', letter.content,
      letter.createdAt, letter.direction === 'you-to-ai' ? letter.createdAt : letter.deliveredAt, '原信');
    const replyAt = letter.direction === 'you-to-ai' ? letter.deliveredAt ?? letter.completedAt : letter.completedAt;
    add('reply', letter.direction === 'you-to-ai' ? 'I' : 'you', letter.replyContent,
      replyAt, replyAt, '回信');
  }
  return parts;
}

export async function loadLetterMemoryPart(sessionId: string, messageId: string): Promise<LetterMemoryPart | null> {
  if (!sessionId.startsWith('letter:')) return null;
  const letterId = sessionId.slice('letter:'.length);
  const letter = originalReader ? await originalReader(letterId) : (await loadLetters()).find(item => item.id === letterId);
  return letter ? getLetterMemoryParts(letter).find(part => part.messageId === messageId) ?? null : null;
}
