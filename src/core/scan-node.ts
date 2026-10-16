import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename as pbasename, resolve } from 'node:path';
import type { Config } from './config.js';
import { build, makeClassifier, scanZipBuffer } from './scanner.js';
import type { Project, ProjectFile } from './types.js';

export async function scanFolder(dir: string, cfg: Config): Promise<Project> {
  const root = resolve(dir);
  const st = await stat(root).catch(() => null);
  if (!st?.isDirectory()) throw new Error(`Not a directory: ${dir}`);
  const cls = makeClassifier(cfg);
  const files: ProjectFile[] = [];

  async function walk(rel: string): Promise<void> {
    const entries = await readdir(join(root, rel), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue; // never follow links out of the project
      if (e.isDirectory()) {
        const c = cls.classify(p + '/');
        if (c.omitted) {
          files.push({ path: p + '/', size: 0, kind: 'text', ignored: true, omitted: true, ignoreReason: c.reason });
          continue;
        }
        await walk(p);
      } else if (e.isFile()) {
        const full = join(root, p);
        const s = await stat(full);
        const c = cls.classify(p);
        if (c.omitted) {
          files.push({ path: p, size: s.size, kind: 'text', ignored: true, omitted: true, ignoreReason: c.reason });
          continue;
        }
        files.push(build(p, s.size, await readFile(full), cls, cfg));
      }
    }
  }
  await walk('');
  return { name: pbasename(root), source: 'folder', files };
}

export async function scanZip(zipPath: string, cfg: Config): Promise<Project> {
  const buf = await readFile(zipPath);
  return scanZipBuffer(buf, pbasename(zipPath).replace(/\.zip$/i, ''), cfg);
}

export async function scanInput(input: string, cfg: Config): Promise<Project> {
  const st = await stat(input).catch(() => null);
  if (!st) throw new Error(`Input not found: ${input}`);
  if (st.isDirectory()) return scanFolder(input, cfg);
  if (/\.zip$/i.test(input)) return scanZip(input, cfg);
  throw new Error('Input must be a ZIP file or a folder');
}

