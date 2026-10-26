export type GiftSubject = 'I' | 'you';
export type GiftFileKind = 'image' | 'audio' | 'html';

/** Relative storage names survive a change of device or documentDirectory. */
export type GiftOriginal = {
  id: string;
  storageName: string;
  originalName: string;
  mimeType: string;
  byteSize: number;
};

export type GiftAttachment =
  | { id: string; kind: GiftFileKind; original: GiftOriginal }
  | { id: string; kind: 'url'; url: string };

export type GiftVersion = { id: string; revision: number };
export type GiftWorkToken = GiftVersion & { dataEpoch: number | null };
export type GiftEcho = {
  id: string; giftId: string; giftRevision: number; sequence: number; subject: GiftSubject;
  content: string; createdAt: number; origin: 'message' | 'understanding' | 'reply';
  replyToId: string | null; attachmentId: string | null; originalId: string | null; readAt: number | null;
};
export type GiftEchoThread = { token: GiftWorkToken; messages: GiftEcho[]; pendingYouIds: string[] };
export type GiftReceptionDecision = {
  choice: 'open' | 'later' | 'decline';
  reconsiderAfterMinutes: number | null;
};
export type GiftAttachmentToken = GiftWorkToken & { attachmentId: string; viewer: GiftSubject };
export type GiftWebProgress = { state: unknown; storage: Record<string, string>; summary: string };
export type GiftAttachmentActivity = {
  revision: number; progress: GiftWebProgress; progressUpdatedAt: number | null; lastPlayedAt: number | null;
};
export type GiftAttachmentAccess = { token: GiftAttachmentToken; attachment: GiftAttachment; activity: GiftAttachmentActivity };

export type GiftRecord = GiftVersion & {
  sender: GiftSubject;
  title: string;
  note: string;
  cover: GiftOriginal | null;
  attachments: GiftAttachment[];
  /** Added after opening; discovered through the existing echo attachment directory. */
  supplementalAttachmentIds?: string[];
  deliveryStatus: 'draft' | 'scheduled' | 'delivered' | 'withdrawn';
  receptionStatus: 'unopened' | 'deferred' | 'opened' | 'declined';
  scheduledAt: number | null;
  scheduledTimeZone: string | null;
  deliveredAt: number | null;
  openedAt: number | null;
  receptionDecidedAt?: number | null;
  receptionNextAt?: number | null;
  receptionTimeZone?: string | null;
  createdAt: number;
  updatedAt: number;
};

export type GiftFileSource = { uri: string; name: string; mimeType: string };
export type GiftDraftAttachmentInput =
  | { existingId: string }
  | { kind: GiftFileKind; file: GiftFileSource }
  | { kind: 'url'; url: string };

export type GiftSupplementAttachmentInput = Exclude<GiftDraftAttachmentInput, { existingId: string }>;

/** Full draft contents; the expected revision prevents an older form overwriting a newer save. */
export type GiftDraftContents = {
  title: string;
  note: string;
  cover: null | { existingOriginalId: string } | { file: GiftFileSource };
  attachments: readonly GiftDraftAttachmentInput[];
  /** Saving a preparation time does not arm delivery; scheduling is explicit. */
  deliveryPlan?: { at: number; timeZone: string } | null;
};

export type GiftCollectionResult = { deleted: number; failed: number };
export type GiftSaveResult = { gift: GiftRecord; collection: GiftCollectionResult };

/** Recipient projections contain no hidden note, attachment names or internal files. */
export type GiftView =
  | { revealed: true; gift: GiftRecord }
  | { revealed: false; gift: Pick<GiftRecord,
    'id' | 'revision' | 'sender' | 'title' | 'deliveryStatus' | 'receptionStatus'
    | 'deliveredAt' | 'createdAt' | 'updatedAt' | 'receptionNextAt' | 'receptionDecidedAt'> & {
      cover: Pick<GiftOriginal, 'id' | 'storageName' | 'mimeType'> | null;
    } };

export function giftViewFor(gift: GiftRecord, viewer: GiftSubject): GiftView | null {
  if (gift.sender === viewer) return { revealed: true, gift };
  if (gift.deliveryStatus !== 'delivered') return null;
  if (gift.openedAt !== null) return { revealed: true, gift };
  const { id, revision, sender, title, cover, deliveryStatus, receptionStatus,
    deliveredAt, createdAt, updatedAt, receptionNextAt, receptionDecidedAt } = gift;
  const wrapping = cover ? { id: cover.id, storageName: cover.storageName, mimeType: cover.mimeType } : null;
  return { revealed: false, gift: { id, revision, sender, title, cover: wrapping, deliveryStatus,
    receptionStatus, deliveredAt, createdAt, updatedAt, receptionNextAt, receptionDecidedAt } };
}
