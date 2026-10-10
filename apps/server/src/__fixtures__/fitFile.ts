/**
 * Builds small synthetic FIT files for the weather reader's tests, so no
 * real activity file (with its GPS track) is committed. Each message gets
 * its own definition on local type 0, little-endian unless asked otherwise.
 */

/** FIT base types the tests use, as `fit_base_type_id` values. */
export const FIT_TYPES = {
  uint8: 0x02,
  sint8: 0x01,
  uint16: 0x84,
  string: 0x07,
} as const;

type FitType = (typeof FIT_TYPES)[keyof typeof FIT_TYPES];

export interface FitField {
  num: number;
  type: FitType;
  value: number | string;
  /** Bytes for a string field (NUL-padded). */
  size?: number;
}

export interface FitDevField {
  num: number;
  devIndex: number;
  type: FitType;
  value: number;
}

export interface FitMessage {
  global: number;
  fields: FitField[];
  devFields?: FitDevField[];
  bigEndian?: boolean;
  /** Send the data message with a compressed timestamp header. */
  compressedHeader?: boolean;
}

function sizeOf(type: FitType, size?: number): number {
  if (type === FIT_TYPES.string) return size ?? 16;
  return type === FIT_TYPES.uint16 ? 2 : 1;
}

function writeValue(
  out: number[],
  type: FitType,
  value: number | string,
  bigEndian: boolean,
  size?: number,
) {
  if (type === FIT_TYPES.string) {
    const bytes = new TextEncoder().encode(String(value));
    const n = sizeOf(type, size);
    for (let i = 0; i < n; i++) out.push(bytes[i] ?? 0);
    return;
  }
  const v = Number(value);
  if (type === FIT_TYPES.uint16) {
    const lo = v & 0xff;
    const hi = (v >> 8) & 0xff;
    out.push(...(bigEndian ? [hi, lo] : [lo, hi]));
    return;
  }
  out.push(v & 0xff);
}

/** A `field_description` message naming developer field `num`. */
export function fitFieldDescription(
  devIndex: number,
  num: number,
  name: string,
  type: FitType,
  scale?: number,
): FitMessage {
  const fields: FitField[] = [
    { num: 0, type: FIT_TYPES.uint8, value: devIndex },
    { num: 1, type: FIT_TYPES.uint8, value: num },
    { num: 2, type: FIT_TYPES.uint8, value: type },
    { num: 3, type: FIT_TYPES.string, value: name, size: 32 },
  ];
  if (scale !== undefined)
    fields.push({ num: 6, type: FIT_TYPES.uint8, value: scale });
  return { global: 206, fields };
}

/** The bytes of a FIT file holding `messages`, with a 14-byte header. */
export function buildFitFile(messages: FitMessage[]): Uint8Array {
  const data: number[] = [];
  for (const message of messages) {
    const bigEndian = message.bigEndian ?? false;
    const devFields = message.devFields ?? [];
    data.push(0x40 | (devFields.length > 0 ? 0x20 : 0));
    data.push(0, bigEndian ? 1 : 0);
    const g = message.global;
    data.push(...(bigEndian ? [g >> 8, g & 0xff] : [g & 0xff, g >> 8]));
    data.push(message.fields.length);
    for (const field of message.fields)
      data.push(field.num, sizeOf(field.type, field.size), field.type);
    if (devFields.length > 0) {
      data.push(devFields.length);
      for (const field of devFields)
        data.push(field.num, sizeOf(field.type), field.devIndex);
    }
    data.push(message.compressedHeader ? 0x80 : 0x00);
    for (const field of message.fields)
      writeValue(data, field.type, field.value, bigEndian, field.size);
    for (const field of devFields)
      writeValue(data, field.type, field.value, bigEndian);
  }
  const header = [14, 0x20, 0, 0];
  const size = data.length;
  header.push(size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, size >> 24);
  header.push(...[...".FIT"].map((c) => c.charCodeAt(0)), 0, 0);
  // Trailing CRC bytes; the reader does not check them.
  return new Uint8Array([...header, ...data, 0, 0]);
}
