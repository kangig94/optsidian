export type Leb128Read = {
  value: number;
  offset: number;
};

export function encodeUnsignedLeb128(value: number): Uint8Array {
  assertSafeUnsignedInteger(value, 'unsigned LEB128');
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte += 128;
    bytes.push(byte);
  } while (remaining > 0);
  return Uint8Array.from(bytes);
}

export function decodeUnsignedLeb128(bytes: Uint8Array, offset = 0): Leb128Read {
  let value = 0;
  let multiplier = 1;
  let cursor = offset;
  while (cursor < bytes.length) {
    const byte = bytes[cursor];
    value += (byte & 0x7f) * multiplier;
    if (value > Number.MAX_SAFE_INTEGER) throw new Error('unsigned LEB128 exceeds Number.MAX_SAFE_INTEGER');
    cursor += 1;
    if ((byte & 0x80) === 0) {
      assertShortestUnsignedEncoding(bytes.subarray(offset, cursor), value);
      return { value, offset: cursor };
    }
    multiplier *= 128;
    if (multiplier > Number.MAX_SAFE_INTEGER) throw new Error('unsigned LEB128 exceeds Number.MAX_SAFE_INTEGER');
  }
  throw new Error('truncated unsigned LEB128');
}

export function encodeZigZagLeb128(value: number): Uint8Array {
  assertSafeSignedInteger(value, 'zig-zag LEB128');
  const encoded = value >= 0 ? value * 2 : -value * 2 - 1;
  return encodeUnsignedLeb128(encoded);
}

export function decodeZigZagLeb128(bytes: Uint8Array, offset = 0): Leb128Read {
  const read = decodeUnsignedLeb128(bytes, offset);
  const value = read.value % 2 === 0 ? read.value / 2 : -(read.value + 1) / 2;
  assertSafeSignedInteger(value, 'zig-zag LEB128');
  return { value, offset: read.offset };
}

export function assertSafeUnsignedInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

export function assertSafeSignedInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer`);
  }
}

function assertShortestUnsignedEncoding(encoded: Uint8Array, value: number): void {
  const shortest = encodeUnsignedLeb128(value);
  if (shortest.length !== encoded.length) throw new Error('non-canonical unsigned LEB128 encoding');
  for (let index = 0; index < shortest.length; index += 1) {
    if (shortest[index] !== encoded[index]) throw new Error('non-canonical unsigned LEB128 encoding');
  }
}
