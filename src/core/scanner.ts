import type { Config } from './config.js';
import { detectLanguage, isBinary } from './detect.js';
import { canEncode, decodeBytes, encodeString, type TextEncoding } from './encoding.js';
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

export interface Classifier {
  classify(path: string): { ignored: boolean; omitted: boolean; reason?: string };
}

export function makeClassifier(cfg: Config): Classifier {
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

export function build(path: string, size: number, data: Buffer | undefined, cls: Classifier, cfg: Config): ProjectFile {
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
    if (f.kind === 'text' && !f.ignored) {
      const det = decodeBytes(data);
      if (!det) {
        // Undecodable bytes would be corrupted by a round trip through a string: copy them untouched.
        f.ignored = true;
        f.ignoreReason = 'unsupported text encoding (not UTF-8 / Shift_JIS / EUC-JP / UTF-16); copied unchanged';
      } else f.encoding = det.encoding;
    }
    if (!f.ignored && f.kind === 'text' && size > cfg.maxFileSizeBytes) {
      f.ignored = true;
      f.ignoreReason = `larger than maxFileSizeBytes (${cfg.maxFileSizeBytes})`;
    }
  }
  return f;
}

export function scanEntries(
  name: string,
  rawEntries: { path: string; data: Uint8Array }[],
  cfg: Config,
  source: Project['source'] = 'memory',
): Project {
  const entries = rawEntries.map((e) => ({ path: e.path, data: Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data.buffer, e.data.byteOffset, e.data.byteLength) }));
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

export function scanZipBuffer(buf: Uint8Array, name: string, cfg: Config): Project {
  const { entries, root } = stripSingleRoot(readZip(buf));
  return scanEntries(root ?? name, entries, cfg, 'zip');
}

export function decodeText(f: ProjectFile): { text: string; bom: boolean; encoding: TextEncoding } {
  const det = decodeBytes(f.data ?? Buffer.alloc(0));
  if (!det) return { text: '', bom: false, encoding: 'utf-8' };
  return { text: det.text, bom: det.bom, encoding: det.encoding };
}

export function encodeText(text: string, bom: boolean, encoding: TextEncoding = 'utf-8'): Buffer {
  return encodeString(text, encoding, bom);
}

export { canEncode };

export function copyableFiles(files: ProjectFile[]): { path: string; data: Buffer }[] {
  return files.filter((f) => !f.omitted && f.data).map((f) => ({ path: f.path, data: f.data! }));
}
