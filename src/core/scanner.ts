import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename as pbasename, resolve } from 'node:path';
import type { Config } from './config.js';
import { detectLanguage, isBinary } from './detect.js';
import { globToRegExp, matchesAny } from './glob.js';
import type { Project, ProjectFile } from './types.js';
import { readZip, stripSingleRoot } from './zip.js';

/** Excluded from the refined project entirely (not source, can be re-created). */
export const DEFAULT_OMIT = [
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache',
  '.pytest_cache', 'target', '.gradle', '.DS_Store', 'Thumbs.db', '.coderefiner-out',
];

/** Copied unchanged, but never analysed or modified. */
export const DEFAULT_IGNORE = [
  'dist', 'build', 'coverage', '.next', '.nuxt', '.cache', '.parcel-cache', '.turbo', 'out',
  '*.min.js', '*.min.css', '*.map', '*.bundle.js', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'Cargo.lock', 'bun.lockb', 'composer.lock', 'Gemfile.lock', 'poetry.lock',
];

interface Classifier {
  classify(path: string): { ignored: boolean; omitted: boolean; reason?: string };
}

function makeClassifier(cfg: Config): Classifier {
  const omit = [...DEFAULT_OMIT, ...cfg.omit].map((p) => ({ p, re: globToRegExp(p) }));
  const ignore = [...DEFAULT_IGNORE, ...cfg.ignore].map((p) => ({ p, re: globToRegExp(p) }));
  const include = cfg.include.map(globToRegExp);
  return {
    classify(path) {
      if (matchesAny(path, include)) return { ignored: false, omitted: false };
      const o = omit.find((x) => x.re.test(path));
      if (o) return { ignored: true, omitted: true, reason: `omitted by "${o.p}"` };
      const i = ignore.find((x) => x.re.test(path));
      if (i) return { ignored: true, omitted: false, reason: `ignored by "${i.p}"` };
      return { ignored: false, omitted: false };
    },
  };
}

function build(path: string, size: number, data: Buffer | undefined, cls: Classifier, cfg: Config): ProjectFile {
  const c = cls.classify(path);
  const f: ProjectFile = {
    path,
    size,
    kind: 'text',
    language: detectLanguage(path),
    ignored: c.ignored,
    omitted: c.omitted,
    ignoreReason: c.reason,
    data,
  };
  if (data) {
    f.kind = isBinary(path, data) ? 'binary' : 'text';
    if (f.kind === 'binary') f.language = undefined;
    if (!f.ignored && f.kind === 'text' && size > cfg.maxFileSizeBytes) {
      f.ignored = true;
      f.ignoreReason = `larger than maxFileSizeBytes (${cfg.maxFileSizeBytes})`;
    }
  }
  return f;
}

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

export function scanEntries(
  name: string,
  entries: { path: string; data: Buffer }[],
  cfg: Config,
  source: Project['source'] = 'memory',
): Project {
  const cls = makeClassifier(cfg);
  const files = entries
    .map((e) => {
      const c = cls.classify(e.path);
      if (c.omitted) {
        return { path: e.path, size: e.data.length, kind: 'text', ignored: true, omitted: true, ignoreReason: c.reason } as ProjectFile;
      }
      return build(e.path, e.data.length, e.data, cls, cfg);
    })
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  return { name, source, files };
}

export async function scanZip(zipPath: string, cfg: Config): Promise<Project> {
  const buf = await readFile(zipPath);
  return scanZipBuffer(buf, pbasename(zipPath).replace(/\.zip$/i, ''), cfg);
}

export function scanZipBuffer(buf: Buffer, name: string, cfg: Config): Project {
  const { entries, root } = stripSingleRoot(readZip(buf));
  return scanEntries(root ?? name, entries, cfg, 'zip');
}

export async function scanInput(input: string, cfg: Config): Promise<Project> {
  const st = await stat(input).catch(() => null);
  if (!st) throw new Error(`Input not found: ${input}`);
  if (st.isDirectory()) return scanFolder(input, cfg);
  if (/\.zip$/i.test(input)) return scanZip(input, cfg);
  throw new Error('Input must be a ZIP file or a folder');
}

export function decodeText(f: ProjectFile): { text: string; bom: boolean } {
  const data = f.data ?? Buffer.alloc(0);
  const bom = data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf;
  return { text: data.toString('utf8', bom ? 3 : 0), bom };
}

export function encodeText(text: string, bom: boolean): Buffer {
  const body = Buffer.from(text, 'utf8');
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}
