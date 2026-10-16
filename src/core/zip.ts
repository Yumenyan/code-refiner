import AdmZip from 'adm-zip';
import { posix } from 'node:path';

export interface ZipEntryData {
  path: string;
  data: Buffer;
}

const MAX_ENTRIES = 200_000;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

/** Normalises an archive path; returns null for unsafe paths (zip-slip) or directories. */
export function safeEntryPath(raw: string): string | null {
  const p = raw.replace(/\\/g, '/');
  if (p.endsWith('/')) return null;
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null;
  const n = posix.normalize(p);
  if (n === '..' || n.startsWith('../') || n.includes('\0')) return null;
  return n.replace(/^\.\//, '');
}

export function readZip(buffer: Buffer): ZipEntryData[] {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  if (entries.length > MAX_ENTRIES) throw new Error('ZIP has too many entries');
  const out: ZipEntryData[] = [];
  let total = 0;
  for (const e of entries) {
    if (e.isDirectory) continue;
    const p = safeEntryPath(e.entryName);
    if (!p) continue;
    if (p.startsWith('__MACOSX/') || p.endsWith('.DS_Store')) continue;
    total += e.header.size;
    if (total > MAX_TOTAL_BYTES) throw new Error('ZIP is too large when extracted');
    out.push({ path: p, data: e.getData() });
  }
  return out;
}

export function writeZip(entries: ZipEntryData[]): Buffer {
  const zip = new AdmZip();
  for (const e of [...entries].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    zip.addFile(e.path, e.data);
  }
  return zip.toBuffer();
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
