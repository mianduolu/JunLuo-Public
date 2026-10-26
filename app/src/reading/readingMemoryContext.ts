import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import type { ReadingMemorySourceInfo } from './readingMemorySource';

/** Source coordinates are context, not part of either speaker's quotation. */
export function getReadingMemorySourceContext(message: SubjectiveMessage) {
  const info = (message as SubjectiveMessage & { readingMemorySourceInfo?: ReadingMemorySourceInfo }).readingMemorySourceInfo;
  return info ? [`《${info.bookTitle}》`, info.chapterTitle, info.positionLabel].filter(Boolean).join(' · ') : '';
}

export function readingMemorySourceContextVersion(message: SubjectiveMessage) {
  return (message as SubjectiveMessage & { readingMemorySourceInfo?: ReadingMemorySourceInfo }).readingMemorySourceInfo?.version;
}
