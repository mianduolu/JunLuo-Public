export const COLMI_PACKET_LENGTH = 16;
export const COLMI_PACKET_DATA_LENGTH = 14;

function assertByte(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`${label} must be an integer between 0 and 255`);
  }
}

export function calculateColmiChecksum(bytes: readonly number[]): number {
  let sum = 0;
  bytes.forEach((byte, index) => {
    assertByte(byte, `byte at index ${index}`);
    sum += byte;
  });
  return sum & 0xff;
}

export function makeColmiPacket(command: number, data: readonly number[] = []): number[] {
  assertByte(command, 'command');

  if (data.length > COLMI_PACKET_DATA_LENGTH) {
    throw new RangeError(`data must contain at most ${COLMI_PACKET_DATA_LENGTH} bytes`);
  }

  const packet = Array(COLMI_PACKET_LENGTH).fill(0) as number[];
  packet[0] = command;

  data.forEach((byte, index) => {
    assertByte(byte, `data byte at index ${index}`);
    packet[index + 1] = byte;
  });

  packet[COLMI_PACKET_LENGTH - 1] = calculateColmiChecksum(packet.slice(0, COLMI_PACKET_LENGTH - 1));
  return packet;
}

export function bytesToHex(bytes: readonly number[]): string {
  return bytes
    .map((byte, index) => {
      assertByte(byte, `byte at index ${index}`);
      return byte.toString(16).padStart(2, '0');
    })
    .join(' ');
}

export function hexToBytes(hex: string): number[] {
  const normalized = hex.replace(/0x/gi, '').replace(/\s+/g, '');
  if (normalized.length === 0) {
    return [];
  }
  if (normalized.length % 2 !== 0) {
    throw new RangeError('hex string must contain an even number of digits');
  }
  if (!/^[0-9a-fA-F]+$/.test(normalized)) {
    throw new RangeError('hex string contains non-hex characters');
  }

  const bytes: number[] = [];
  for (let index = 0; index < normalized.length; index += 2) {
    bytes.push(Number.parseInt(normalized.slice(index, index + 2), 16));
  }
  return bytes;
}
