import iconv from 'iconv-lite';

export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'cp932' | 'euc-jp';

export interface DetectedText {
  encoding: TextEncoding;
  text: string;
  bom: boolean;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Counts kana / kanji: used to pick between legacy Japanese encodings that both decode without errors. */
function japaneseScore(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xff66 && c <= 0xff9f)) n++;
    else if (c === 0xfffd) return -1;
  }
  return n;
}

/**
 * Detects how a text file is encoded. A legacy encoding is accepted only when decoding and
 * re-encoding reproduces the original bytes exactly, so writing the file back can never corrupt it.
 * Returns null when the bytes cannot be handled losslessly (the file is then left untouched).
 */
export function decodeBytes(data: Uint8Array): DetectedText | null {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
    const text = iconv.decode(buf.subarray(2), 'utf-16le');
    return Buffer.compare(Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(text, 'utf-16le')]), buf) === 0 ? { encoding: 'utf-16le', text, bom: true } : null;
  }
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
    const text = iconv.decode(buf.subarray(2), 'utf-16be');
    return Buffer.compare(Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode(text, 'utf-16be')]), buf) === 0 ? { encoding: 'utf-16be', text, bom: true } : null;
  }
  const bom = data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf;
  try {
    return { encoding: 'utf-8', text: utf8.decode(bom ? data.subarray(3) : data), bom };
  } catch {
    /* not UTF-8: try legacy Japanese encodings */
  }
  let best: { enc: TextEncoding; text: string; score: number } | null = null;
  for (const enc of ['cp932', 'euc-jp'] as const) {
    const text = iconv.decode(buf, enc);
    if (Buffer.compare(iconv.encode(text, enc), buf) !== 0) continue;
    const score = japaneseScore(text);
    if (score >= 0 && (!best || score > best.score)) best = { enc, text, score };
  }
  return best ? { encoding: best.enc, text: best.text, bom: false } : null;
}

export function encodeString(text: string, encoding: TextEncoding, bom: boolean): Buffer {
  if (encoding === 'utf-8') {
    const body = Buffer.from(text, 'utf8');
    return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
  }
  const body = iconv.encode(text, encoding);
  if (encoding === 'utf-16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), body]);
  if (encoding === 'utf-16be') return Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
  return body;
}

/** A string that is representable in the file's encoding (legacy encodings cannot hold e.g. emoji). */
export function canEncode(text: string, encoding: TextEncoding): boolean {
  if (encoding === 'utf-8' || encoding.startsWith('utf-16')) return true;
  return iconv.decode(iconv.encode(text, encoding), encoding) === text;
}
