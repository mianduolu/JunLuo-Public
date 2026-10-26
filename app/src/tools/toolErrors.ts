import type { JunLuoToolError, JunLuoToolErrorCode } from './toolTypes';

export function createToolError(
  code: JunLuoToolErrorCode,
  message: string,
  details?: unknown,
): JunLuoToolError {
  return details === undefined
    ? { code, message }
    : { code, message, details };
}

export class JunLuoToolRegistryError extends Error {
  readonly toolError: JunLuoToolError;

  constructor(code: JunLuoToolErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'JunLuoToolRegistryError';
    this.toolError = createToolError(code, message, details);
  }
}
