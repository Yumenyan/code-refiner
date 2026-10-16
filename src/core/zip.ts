import { unzipSync, zipSync, type Zippable } from 'fflate';

export interface ZipEntryData {
  path: string;
  data: Uint8Array;
}

const MAX_ENTRIES = 200_000;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

/** Normalises an archive path; returns null for unsafe paths (zip-slip) or directories. */
export function safeEntryPath(raw: string): string | null {
  const p = raw.replace(/\\/g, '/');
  if (p.endsWith('/')) return null;
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p) || p.includes('\0')) return null;
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  if (out[0] === '..' ) return null;
  return out.length ? out.join('/') : null;
}

export function readZip(buffer: Uint8Array): ZipEntryData[] {
  let total = 0;
  let count = 0;
  const files = unzipSync(buffer, {
    filter(f) {
      count++;
      if (count > MAX_ENTRIES) throw new Error('ZIP has too many entries');
      total += f.originalSize;
      if (total > MAX_TOTAL_BYTES) throw new Error('ZIP is too large when extracted');
      const p = safeEntryPath(f.name);
      return !!p && !p.startsWith('__MACOSX/') && !p.endsWith('.DS_Store');
    },
  });
  const out: ZipEntryData[] = [];
  for (const [name, data] of Object.entries(files)) {
    const p = safeEntryPath(name);
    if (p) out.push({ path: p, data });
  }
  return out;
}

export function writeZip(entries: ZipEntryData[]): Uint8Array {
  const z: Zippable = {};
  for (const e of [...entries].sort((a, b) => (a.path < b.path ? -1 : 1))) z[e.path] = [e.data, { mtime: new Date(2020, 0, 1) }];
  return zipSync(z);
}

/** If every entry lives under one top-level directory, strip it (typical GitHub ZIP layout). */
export function stripSingleRoot(entries: ZipEntryData[]): { entries: ZipEntryData[]; root?: string } {
  if (entries.length === 0) return { entries };
  const first = entries[0].path.split('/')[0];
  if (entries.every((e) => e.path.includes('/') && e.path.split('/')[0] === first)) {
    return { entries: entries.map((e) => ({ path: e.path.slice(first.length + 1), data: e.data })), root: first };
  }
  return { entries };
}
