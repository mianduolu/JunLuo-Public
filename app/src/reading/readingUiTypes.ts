export type ScreenMode = 'library' | 'reader' | 'notes';

export type ParagraphActionMode = 'menu' | 'question' | 'note';

export type ParagraphActionState = {
  p: number;
  mode: ParagraphActionMode;
};

export type ReaderThemeName = 'paper' | 'green' | 'night';

export type ReaderSettings = {
  fontSize: number;
  lineHeightMultiplier: number;
  paragraphSpacing: number;
  theme: ReaderThemeName;
};

export type ReadingBookShelfMeta = {
  chapterLabel: string;
  paragraphLabel: string;
  progressLabel: `${number}%`;
  lastOpenedLabel: string;
  fileWarning?: string;
};

export type ReadingLibraryPulse = {
  sourceAnchor?: import('./readingTypes').ReadingSourceAnchor;
  kind: 'annotation' | 'summary' | 'note';
  bookId: string;
  bookTitle: string;
  chapterIndex: number;
  paragraphIndex: number;
  label: string;
  text: string;
  createdAt: number;
};

export type ReadingLibraryStats = {
  minutesToday: number;
  annotationItems: ReadingLibraryPulse[];
  noteItems: ReadingLibraryPulse[];
  bookCount: number;
  recentPulse?: ReadingLibraryPulse;
};
