export type VoiceCallAttemptOperations = {
  configureAudio: () => Promise<void>;
  startAudioSession: () => Promise<void>;
  connectRoom: () => Promise<void>;
  enableMicrophone: () => Promise<void>;
  disableMicrophone: () => Promise<void>;
  disconnectRoom: () => Promise<void>;
  stopAudioSession: () => Promise<void>;
  restoreAudioMode: () => Promise<void>;
};

export type VoiceCallAttemptDependencies<Room> = {
  configureAudio: () => Promise<void>;
  startAudioSession: () => Promise<void>;
  createRoom: (livekitUrl: string) => Room;
  connectRoom: (room: Room, livekitUrl: string) => Promise<void>;
  enableMicrophone: (room: Room) => Promise<void>;
  disableMicrophone: (room: Room) => Promise<void>;
  disconnectRoom: (room: Room) => Promise<void>;
  stopAudioSession: () => Promise<void>;
  restoreAudioMode: () => Promise<void>;
};

export type VoiceCallAttemptCallbacks<Room> = {
  onRoomConnected?: (room: Room, livekitUrl: string) => void;
  onRoomSelected?: (room: Room, livekitUrl: string) => void;
};

export type VoiceCallAttempt<Room> = {
  cancel: () => void;
  getCurrentRoom: () => Room | null;
  isCancelled: () => boolean;
  operations: VoiceCallAttemptOperations;
};

export class VoiceCallAttemptCancelledError extends Error {
  constructor() {
    super('Voice call attempt was cancelled');
    this.name = 'VoiceCallAttemptCancelledError';
  }
}

export class VoiceCallAttemptCleanupError extends Error {
  readonly errors: readonly unknown[];

  constructor(errors: readonly unknown[]) {
    super(`Voice call attempt cleanup failed in ${errors.length} operation(s)`);
    this.name = 'VoiceCallAttemptCleanupError';
    this.errors = errors;
  }
}

export type VoiceCallRequestTimeoutOptions = Readonly<{
  abort: () => void;
  timeoutError: unknown;
  timeoutMs: number;
}>;

export function raceVoiceCallRequestWithTimeout<T>(
  request: Promise<T>,
  options: VoiceCallRequestTimeoutOptions,
) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(options.timeoutError);
      try {
        options.abort();
      } catch {
        // The timeout result is already authoritative; abort is best-effort compensation.
      }
    }, Math.max(1, options.timeoutMs));
  });
  return Promise.race([request, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

function throwCleanupErrors(errors: unknown[]) {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new VoiceCallAttemptCleanupError(errors);
}

export function createVoiceCallAttempt<Room>(
  livekitUrls: readonly string[],
  dependencies: VoiceCallAttemptDependencies<Room>,
  callbacks: VoiceCallAttemptCallbacks<Room> = {},
): VoiceCallAttempt<Room> {
  if (livekitUrls.length === 0) throw new Error('Voice call attempt requires a LiveKit URL');

  let cancelled = false;
  let connectPromise: Promise<void> | null = null;
  let currentRoom: Room | null = null;
  const ownedRooms: Room[] = [];

  const ensureActive = () => {
    if (cancelled) throw new VoiceCallAttemptCancelledError();
  };

  const runSetupOperation = async (operation: () => Promise<void>) => {
    ensureActive();
    await operation();
    ensureActive();
  };

  const disconnectOwnedRooms = async () => {
    const errors: unknown[] = [];
    for (const room of ownedRooms) {
      try {
        await dependencies.disconnectRoom(room);
      } catch (error) {
        errors.push(error);
      }
    }
    throwCleanupErrors(errors);
  };

  const connectOwnedRoom = async () => {
    let lastConnectError: unknown;
    for (const livekitUrl of livekitUrls) {
      ensureActive();
      const room = dependencies.createRoom(livekitUrl);
      ownedRooms.push(room);
      currentRoom = room;
      callbacks.onRoomSelected?.(room, livekitUrl);
      try {
        await dependencies.connectRoom(room, livekitUrl);
      } catch (connectError) {
        try {
          await dependencies.disconnectRoom(room);
        } catch (cleanupError) {
          throw new VoiceCallAttemptCleanupError([connectError, cleanupError]);
        }
        if (currentRoom === room) currentRoom = null;
        if (cancelled) throw new VoiceCallAttemptCancelledError();
        lastConnectError = connectError;
        continue;
      }

      if (cancelled) {
        await dependencies.disconnectRoom(room);
        throw new VoiceCallAttemptCancelledError();
      }
      callbacks.onRoomConnected?.(room, livekitUrl);
      return;
    }
    throw lastConnectError ?? new Error('Voice call attempt could not connect to LiveKit');
  };

  const operations: VoiceCallAttemptOperations = {
    configureAudio: () => runSetupOperation(dependencies.configureAudio),
    startAudioSession: () => runSetupOperation(dependencies.startAudioSession),
    connectRoom: () => {
      if (!connectPromise) {
        connectPromise = connectOwnedRoom().finally(() => {
          connectPromise = null;
        });
      }
      return connectPromise;
    },
    enableMicrophone: async () => {
      ensureActive();
      const room = currentRoom;
      if (!room) throw new Error('Voice call attempt has no connected Room');
      await dependencies.enableMicrophone(room);
      if (!cancelled) return;

      const cleanupErrors: unknown[] = [];
      try {
        await dependencies.disableMicrophone(room);
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await dependencies.disconnectRoom(room);
      } catch (error) {
        cleanupErrors.push(error);
      }
      throwCleanupErrors(cleanupErrors);
      throw new VoiceCallAttemptCancelledError();
    },
    disableMicrophone: async () => {
      if (currentRoom) await dependencies.disableMicrophone(currentRoom);
    },
    disconnectRoom: async () => {
      cancelled = true;
      await disconnectOwnedRooms();
    },
    stopAudioSession: dependencies.stopAudioSession,
    restoreAudioMode: dependencies.restoreAudioMode,
  };

  return {
    cancel: () => {
      cancelled = true;
    },
    getCurrentRoom: () => currentRoom,
    isCancelled: () => cancelled,
    operations,
  };
}
