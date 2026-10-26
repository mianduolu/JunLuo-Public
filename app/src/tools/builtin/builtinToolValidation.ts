import { createToolError } from '../toolErrors';
import { createToolErrorResult } from '../toolResult';
import type { JunLuoToolCall, JunLuoToolResult } from '../toolTypes';

export function readStringInput(input: Record<string, unknown>, key: string) {
  const value = input[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function readOptionalStringInput(input: Record<string, unknown>, key: string) {
  const value = input[key];
  return typeof value === 'string' ? value.trim() : undefined;
}

export function readNumberInput(input: Record<string, unknown>, key: string) {
  const value = input[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function readBooleanInput(input: Record<string, unknown>, key: string) {
  const value = input[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function readStringArrayInput(input: Record<string, unknown>, key: string) {
  const value = input[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}

export function validationFailed<TData = unknown>(
  call: JunLuoToolCall,
  message: string,
  summary: string,
): JunLuoToolResult<TData> {
  return createToolErrorResult<TData>(call, createToolError('VALIDATION_FAILED', message), summary);
}

export function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

export function isValidTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
