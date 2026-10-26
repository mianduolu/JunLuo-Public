import { Buffer } from 'buffer';

import { assertBase64Url } from './syncProtocol';

export function bytesToBase64Url(value: Uint8Array) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function base64UrlToBytes(
  value: string,
  label: string,
  expectedLength?: number,
) {
  assertBase64Url(
    value,
    label,
    expectedLength === undefined ? {} : { exactBytes: expectedLength },
  );
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const decoded = new Uint8Array(Buffer.from(
    `${value.replace(/-/g, '+').replace(/_/g, '/')}${padding}`,
    'base64',
  ));
  if (bytesToBase64Url(decoded) !== value) {
    throw new Error(
      `${label} 必须使用规范、无填充的 base64url 编码。`,
    );
  }
  return decoded;
}
