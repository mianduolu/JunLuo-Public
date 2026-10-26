export type JunLuoToolAgentTurnErrorCode =
  | 'TURN_ALREADY_ACTIVE'
  | 'TURN_NOT_ACTIVE'
  | 'TURN_ID_MISMATCH'
  | 'INVALID_TURN_TRANSITION'
  | 'TURN_CANCELLED'
  | 'STALE_DATA_EPOCH'
  | 'SOURCE_SESSION_REMOVED'
  | 'SOURCE_MESSAGE_REMOVED';

export type JunLuoToolAgentFailureCode =
  | 'PROVIDER_ERROR'
  | 'PROTOCOL_ERROR'
  | 'HOST_ERROR'
  | 'MODEL_REQUEST_LIMIT';

export class JunLuoToolAgentTurnError extends Error {
  readonly code: JunLuoToolAgentTurnErrorCode;

  constructor(code: JunLuoToolAgentTurnErrorCode, message: string) {
    super(message);
    this.name = 'JunLuoToolAgentTurnError';
    this.code = code;
  }
}

