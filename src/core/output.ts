import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { ProjectFile } from './types.js';

/** Writes files below `root`, refusing any path that would escape it. */
export async function writeFiles(root: string, files: { path: string; data: Buffer }[]): Promise<void> {
  const base = resolve(root);
  for (const f of files) {
    const target = resolve(base, f.path);
    if (target !== base && !target.startsWith(base + sep)) throw new Error(`Refusing to write outside output: ${f.path}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, f.data);
  }
}

export function copyableFiles(files: ProjectFile[]): { path: string; data: Buffer }[] {
  return files.filter((f) => !f.omitted && f.data).map((f) => ({ path: f.path, data: f.data! }));
}

export async function resetDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
}
