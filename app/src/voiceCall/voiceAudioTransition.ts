export type VoiceAudioAcceptFailureStage =
  | 'release-chat'
  | 'audio-not-free'
  | 'configure-audio'
  | 'start-audio-session'
  | 'connect-room'
  | 'enable-microphone';

export type VoiceAudioAcceptResult =
  | { status: 'connected' }
  | { status: 'cancelled' }
  | { status: 'failed'; stage: VoiceAudioAcceptFailureStage; error?: unknown };

export type VoiceAudioDisconnectResult = {
  released: boolean;
  error?: unknown;
};

export type VoiceAudioTransitionOperations = {
  releaseChatAudio: () => Promise<boolean>;
  configureAudio: () => Promise<void>;
  startAudioSession: () => Promise<void>;
  connectRoom: () => Promise<void>;
  enableMicrophone: () => Promise<void>;
  disableMicrophone: () => Promise<void>;
  disconnectRoom: () => Promise<void>;
  stopAudioSession: () => Promise<void>;
  restoreAudioMode: () => Promise<void>;
};

export type VoiceAudioTransitionCoordinatorOptions = Readonly<{
  connectRoomTimeoutMs?: number;
  releaseChatTimeoutMs?: number;
  stepTimeoutMs?: number;
}>;

export type VoiceAudioReservation = Readonly<{
  generation: number;
}>;

type VoiceAudioPhase =
  | 'releasing-chat'
  | 'configuring-audio'
  | 'starting-audio-session'
  | 'connecting-room'
  | 'enabling-microphone'
  | 'connected'
  | 'cleaning-up'
  | 'released'
  | 'failed';

type StepOutcome =
  | { ok: true }
  | { ok: false; error: unknown };

type SetupCleanupKind = 'configure' | 'session' | 'room' | 'microphone';

type ReservationState = {
  acceptPromise: Promise<VoiceAudioAcceptResult> | null;
  cancelled: boolean;
  cleanupError: unknown;
  cleanupFailed: boolean;
  cleanupTail: Promise<void>;
  compensationScheduled: boolean;
  disconnectPromise: Promise<VoiceAudioDisconnectResult> | null;
  handle: VoiceAudioReservation;
  hadTimeout: boolean;
  inFlightSetupCount: number;
  needsDisableMicrophone: boolean;
  needsDisconnectRoom: boolean;
  needsRestoreAudioMode: boolean;
  needsStopAudioSession: boolean;
  operations: VoiceAudioTransitionOperations;
  ownsGlobalAudio: boolean;
  phase: VoiceAudioPhase;
  releaseConfirmed: boolean;
  releaseError: unknown;
  releasePending: boolean;
  releasePromise: Promise<boolean>;
};

const DEFAULT_STEP_TIMEOUT_MS = 3_000;

class VoiceAudioStepTimeoutError extends Error {
  constructor(step: string, timeoutMs: number) {
    super(`Voice audio step ${step} timed out after ${timeoutMs}ms`);
    this.name = 'VoiceAudioStepTimeoutError';
  }
}

function failed(stage: VoiceAudioAcceptFailureStage, error?: unknown): VoiceAudioAcceptResult {
  return error === undefined
    ? { stage, status: 'failed' }
    : { error, stage, status: 'failed' };
}

export class VoiceAudioTransitionCoordinator {
  private audioAvailable = true;
  private audioOwner: ReservationState | null = null;
  private readonly connectRoomTimeoutMs: number;
  private current: ReservationState | null = null;
  private failClosed = false;
  private generation = 0;
  private readonly releaseChatTimeoutMs: number;
  private readonly stepTimeoutMs: number;
  private readonly states = new WeakMap<VoiceAudioReservation, ReservationState>();
  private transitionTail: Promise<void> = Promise.resolve();

  constructor(options: VoiceAudioTransitionCoordinatorOptions = {}) {
    const requestedTimeout = options.stepTimeoutMs;
    this.stepTimeoutMs = typeof requestedTimeout === 'number'
      && Number.isFinite(requestedTimeout)
      && requestedTimeout > 0
      ? requestedTimeout
      : DEFAULT_STEP_TIMEOUT_MS;
    const requestedConnectRoomTimeout = options.connectRoomTimeoutMs;
    this.connectRoomTimeoutMs = typeof requestedConnectRoomTimeout === 'number'
      && Number.isFinite(requestedConnectRoomTimeout)
      && requestedConnectRoomTimeout > 0
      ? requestedConnectRoomTimeout
      : this.stepTimeoutMs;
    const requestedReleaseTimeout = options.releaseChatTimeoutMs;
    this.releaseChatTimeoutMs = typeof requestedReleaseTimeout === 'number'
      && Number.isFinite(requestedReleaseTimeout)
      && requestedReleaseTimeout > 0
      ? requestedReleaseTimeout
      : this.stepTimeoutMs;
  }

  reserve(operations: VoiceAudioTransitionOperations): VoiceAudioReservation {
    const previous = this.current;
    if (previous) {
      previous.cancelled = true;
      void this.cleanUp(previous);
      this.ensureDisconnect(previous);
    }

    const handle = Object.freeze({ generation: this.generation + 1 });
    this.generation = handle.generation;
    const state: ReservationState = {
      acceptPromise: null,
      cancelled: false,
      cleanupError: undefined,
      cleanupFailed: false,
      cleanupTail: Promise.resolve(),
      compensationScheduled: false,
      disconnectPromise: null,
      handle,
      hadTimeout: false,
      inFlightSetupCount: 0,
      needsDisableMicrophone: false,
      needsDisconnectRoom: false,
      needsRestoreAudioMode: false,
      needsStopAudioSession: false,
      operations,
      ownsGlobalAudio: false,
      phase: 'releasing-chat',
      releaseConfirmed: false,
      releaseError: undefined,
      releasePending: true,
      releasePromise: Promise.resolve(false),
    };
    state.releasePromise = this.releaseChatAudio(state);
    this.states.set(handle, state);
    this.current = state;
    return handle;
  }

  accept(reservation: VoiceAudioReservation): Promise<VoiceAudioAcceptResult> {
    const state = this.getState(reservation);
    if (!state.acceptPromise) {
      state.acceptPromise = this.enqueue(() => this.runAccept(state));
    }
    return state.acceptPromise;
  }

  disconnect(reservation: VoiceAudioReservation): Promise<VoiceAudioDisconnectResult> {
    const state = this.getState(reservation);
    state.cancelled = true;
    void this.cleanUp(state);
    return this.ensureDisconnect(state);
  }

  isReserved(reservation?: VoiceAudioReservation) {
    if (!reservation) return this.current !== null;
    return this.current?.handle === reservation;
  }

  private getState(reservation: VoiceAudioReservation) {
    const state = this.states.get(reservation);
    if (!state) throw new Error('Unknown voice audio reservation');
    return state;
  }

  private isCurrent(state: ReservationState) {
    return this.current === state && !state.cancelled;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transitionTail
      .catch(() => undefined)
      .then(operation);
    this.transitionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private releaseChatAudio(state: ReservationState) {
    return this.invokeWithTimeout(
      state,
      'release-chat',
      state.operations.releaseChatAudio,
      (fulfilled, value, timedOut) => {
        state.releasePending = false;
        if (fulfilled) {
          state.releaseConfirmed = value === true;
          if (state.releaseConfirmed) {
            state.needsRestoreAudioMode = true;
            if (this.current === state && this.audioOwner === null && !this.failClosed) {
              this.audioAvailable = true;
            }
          } else if (this.current === state) {
            this.audioAvailable = false;
          }
        } else if (!timedOut) {
          state.releaseError = value;
          if (this.current === state) this.audioAvailable = false;
        }
        if (timedOut) this.scheduleCompensatingCleanup(state);
      },
      this.releaseChatTimeoutMs,
    ).then(
      (released) => {
        state.releaseConfirmed = released === true;
        if (state.releaseConfirmed) state.needsRestoreAudioMode = true;
        else if (this.current === state) this.audioAvailable = false;
        return state.releaseConfirmed;
      },
      (error: unknown) => {
        state.releaseError = error;
        if (this.current === state) this.audioAvailable = false;
        return false;
      },
    );
  }

  private async runAccept(state: ReservationState): Promise<VoiceAudioAcceptResult> {
    const chatReleased = await state.releasePromise;
    if (!this.isCurrent(state)) return this.cancelAndCleanUp(state);
    if (!chatReleased) {
      state.phase = 'failed';
      return failed('release-chat', state.releaseError);
    }
    if (!this.audioAvailable || this.audioOwner !== null) {
      state.phase = 'failed';
      return failed('audio-not-free');
    }

    state.ownsGlobalAudio = true;
    this.audioOwner = state;
    this.audioAvailable = false;
    try {
      state.phase = 'configuring-audio';
      await this.runSetupStep(state, 'configure-audio', 'configure', state.operations.configureAudio);
      if (!this.isCurrent(state)) return this.cancelAndCleanUp(state);

      state.phase = 'starting-audio-session';
      await this.runSetupStep(
        state,
        'start-audio-session',
        'session',
        state.operations.startAudioSession,
      );
      if (!this.isCurrent(state)) return this.cancelAndCleanUp(state);

      state.phase = 'connecting-room';
      await this.runSetupStep(
        state,
        'connect-room',
        'room',
        state.operations.connectRoom,
        this.connectRoomTimeoutMs,
      );
      if (!this.isCurrent(state)) return this.cancelAndCleanUp(state);

      state.phase = 'enabling-microphone';
      await this.runSetupStep(
        state,
        'enable-microphone',
        'microphone',
        state.operations.enableMicrophone,
      );
      if (!this.isCurrent(state)) return this.cancelAndCleanUp(state);

      state.phase = 'connected';
      return { status: 'connected' };
    } catch (error) {
      const stage = this.failureStageFor(state.phase);
      await this.cleanUp(state);
      if (!this.isCurrent(state)) return { status: 'cancelled' };
      state.phase = 'failed';
      return failed(stage, error);
    }
  }

  private failureStageFor(phase: VoiceAudioPhase): VoiceAudioAcceptFailureStage {
    if (phase === 'configuring-audio') return 'configure-audio';
    if (phase === 'starting-audio-session') return 'start-audio-session';
    if (phase === 'connecting-room') return 'connect-room';
    return 'enable-microphone';
  }

  private async cancelAndCleanUp(state: ReservationState): Promise<VoiceAudioAcceptResult> {
    await this.cleanUp(state);
    return { status: 'cancelled' };
  }

  private ensureDisconnect(state: ReservationState) {
    if (!state.disconnectPromise) {
      state.disconnectPromise = this.enqueue(async () => {
        await state.releasePromise;
        const result = await this.cleanUp(state);
        if (result.released && this.current === state) {
          this.current = null;
        }
        return result;
      });
    }
    return state.disconnectPromise;
  }

  private markCleanupNeeded(state: ReservationState, kind: SetupCleanupKind) {
    state.needsRestoreAudioMode = true;
    if (kind === 'session') state.needsStopAudioSession = true;
    if (kind === 'room') state.needsDisconnectRoom = true;
    if (kind === 'microphone') {
      state.needsDisableMicrophone = true;
      state.needsDisconnectRoom = true;
    }
  }

  private runSetupStep(
    state: ReservationState,
    step: VoiceAudioAcceptFailureStage,
    cleanupKind: SetupCleanupKind,
    operation: () => Promise<void>,
    timeoutMs = this.stepTimeoutMs,
  ) {
    state.inFlightSetupCount += 1;
    this.markCleanupNeeded(state, cleanupKind);
    return this.invokeWithTimeout(
      state,
      step,
      operation,
      (_fulfilled, _value, timedOut) => {
        state.inFlightSetupCount = Math.max(0, state.inFlightSetupCount - 1);
        this.markCleanupNeeded(state, cleanupKind);
        if (timedOut) this.scheduleCompensatingCleanup(state);
      },
      timeoutMs,
    );
  }

  private invokeWithTimeout<T>(
    state: ReservationState,
    step: string,
    operation: () => Promise<T>,
    onSettled?: (fulfilled: boolean, value: unknown, timedOut: boolean) => void,
    timeoutMs = this.stepTimeoutMs,
  ): Promise<T> {
    let rawPromise: Promise<T>;
    try {
      rawPromise = Promise.resolve(operation());
    } catch (error) {
      rawPromise = Promise.reject(error);
    }

    let didTimeout = false;
    rawPromise.then(
      (value) => onSettled?.(true, value, didTimeout),
      (error: unknown) => onSettled?.(false, error, didTimeout),
    );

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        didTimeout = true;
        state.hadTimeout = true;
        this.failClosed = true;
        this.audioAvailable = false;
        reject(new VoiceAudioStepTimeoutError(step, timeoutMs));
      }, timeoutMs);

      rawPromise.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          reject(error);
        },
      );
    });
  }

  private scheduleCompensatingCleanup(state: ReservationState) {
    if (state.compensationScheduled) return;
    state.compensationScheduled = true;
    const compensation = this.enqueue(async () => {
      state.compensationScheduled = false;
      const result = await this.cleanUp(state);
      if (result.released && this.current === state && state.cancelled) {
        this.current = null;
      }
    });
    void compensation.catch(() => undefined);
  }

  private cleanUp(state: ReservationState): Promise<VoiceAudioDisconnectResult> {
    const result = state.cleanupTail
      .catch(() => undefined)
      .then(() => this.runCleanupPass(state));
    state.cleanupTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async runCleanupPass(state: ReservationState): Promise<VoiceAudioDisconnectResult> {
    state.phase = 'cleaning-up';
    await state.releasePromise;

    if (!state.releaseConfirmed) {
      state.phase = 'failed';
      return state.releaseError === undefined
        ? { released: false }
        : { error: state.releaseError, released: false };
    }

    if (state.needsDisableMicrophone) {
      state.needsDisableMicrophone = false;
      this.recordCleanupOutcome(
        state,
        await this.runCleanupStep(state, 'disable-microphone', state.operations.disableMicrophone),
      );
    }
    if (state.needsDisconnectRoom) {
      state.needsDisconnectRoom = false;
      this.recordCleanupOutcome(
        state,
        await this.runCleanupStep(state, 'disconnect-room', state.operations.disconnectRoom),
      );
    }
    if (state.needsStopAudioSession) {
      state.needsStopAudioSession = false;
      this.recordCleanupOutcome(
        state,
        await this.runCleanupStep(state, 'stop-audio-session', state.operations.stopAudioSession),
      );
    }
    if (state.needsRestoreAudioMode) {
      state.needsRestoreAudioMode = false;
      this.recordCleanupOutcome(
        state,
        await this.runCleanupStep(state, 'restore-audio-mode', state.operations.restoreAudioMode),
      );
    }

    const cleanupStillNeeded = state.needsDisableMicrophone
      || state.needsDisconnectRoom
      || state.needsStopAudioSession
      || state.needsRestoreAudioMode;
    const uncertain = state.inFlightSetupCount > 0 || state.releasePending || cleanupStillNeeded;
    if (state.cleanupFailed || uncertain) {
      this.audioAvailable = false;
      state.phase = 'failed';
      return state.cleanupError === undefined
        ? { released: false }
        : { error: state.cleanupError, released: false };
    }

    if (
      state.hadTimeout
      && (this.audioOwner === state || (this.audioOwner === null && this.current === state))
    ) {
      state.hadTimeout = false;
      this.failClosed = false;
    }
    if (this.failClosed) {
      this.audioAvailable = false;
      state.phase = 'failed';
      return state.cleanupError === undefined
        ? { released: false }
        : { error: state.cleanupError, released: false };
    }

    if (this.audioOwner === state) {
      this.audioOwner = null;
      state.ownsGlobalAudio = false;
    }
    if (this.audioOwner === null) this.audioAvailable = true;
    const released = this.audioAvailable;
    state.phase = released ? 'released' : 'failed';
    return { released };
  }

  private runCleanupStep(
    state: ReservationState,
    step: string,
    operation: () => Promise<void>,
  ): Promise<StepOutcome> {
    return this.invokeWithTimeout(state, step, operation).then(
      () => ({ ok: true }),
      (error: unknown) => ({ error, ok: false }),
    );
  }

  private recordCleanupOutcome(state: ReservationState, outcome: StepOutcome) {
    if (outcome.ok) return;
    state.cleanupFailed = true;
    this.failClosed = true;
    this.audioAvailable = false;
    if (state.cleanupError === undefined) state.cleanupError = outcome.error;
  }
}
