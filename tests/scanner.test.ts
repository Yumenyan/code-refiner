import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/core/config.js';
import { scanZipBuffer } from '../src/core/scanner.js';
import { scanFolder } from '../src/core/scan-node.js';
import { safeEntryPath } from '../src/core/zip.js';
import { globToRegExp } from '../src/core/glob.js';

const cfg = resolveConfig();

describe('Project Scanner', () => {
  it('scans a folder, classifies files and omits/ignores vendor + build output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cr-scan-'));
    await mkdir(join(dir, 'src'), { recursive: true });
    await mkdir(join(dir, 'node_modules/x'), { recursive: true });
    await mkdir(join(dir, 'dist'), { recursive: true });
    await writeFile(join(dir, 'src/a.js'), 'let a = 1;');
    await writeFile(join(dir, 'node_modules/x/i.js'), 'x');
    await writeFile(join(dir, 'dist/bundle.js'), 'y');
    await writeFile(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0, 1, 2]));
    await writeFile(join(dir, 'app.min.js'), 'z');
    await symlink('/etc', join(dir, 'link')).catch(() => undefined);
    const p = await scanFolder(dir, cfg);
    const by = Object.fromEntries(p.files.map((f) => [f.path, f]));
    expect(by['src/a.js']).toMatchObject({ ignored: false, omitted: false, language: 'javascript', kind: 'text' });
    expect(by['node_modules/']).toMatchObject({ omitted: true });
    expect(by['dist/bundle.js']).toMatchObject({ ignored: true, omitted: false });
    expect(by['app.min.js']).toMatchObject({ ignored: true });
    expect(by['logo.png']).toMatchObject({ kind: 'binary' });
    expect(by['link']).toBeUndefined();
  });

  it('can re-include ignored paths through configuration', () => {
    const p = scanZipBuffer(zip({ 'dist/a.js': 'x', 'vendor/b.js': 'y' }), 'p', resolveConfig({ include: ['dist'], ignore: ['vendor'] }));
    const by = Object.fromEntries(p.files.map((f) => [f.path, f]));
    expect(by['dist/a.js'].ignored).toBe(false);
    expect(by['vendor/b.js'].ignored).toBe(true);
  });

  it('reads ZIPs, strips a single wrapper directory and skips unsafe entries', () => {
    const p = scanZipBuffer(zip({ 'proj/index.html': '<p>', 'proj/js/a.js': '1' }), 'x', cfg);
    expect(p.name).toBe('proj');
    expect(p.files.map((f) => f.path)).toEqual(['index.html', 'js/a.js']);
    expect(safeEntryPath('../evil.js')).toBeNull();
    expect(safeEntryPath('/abs.js')).toBeNull();
    expect(safeEntryPath('a/../../b')).toBeNull();
    expect(safeEntryPath('a/b.js')).toBe('a/b.js');
  });

  it('glob matching', () => {
    expect(globToRegExp('node_modules').test('a/node_modules/b.js')).toBe(true);
    expect(globToRegExp('*.min.js').test('x/y.min.js')).toBe(true);
    expect(globToRegExp('src/**/*.test.ts').test('src/a/b/c.test.ts')).toBe(true);
    expect(globToRegExp('src/gen').test('other/src/gen/a')).toBe(false);
  });

  it('files above maxFileSizeBytes are not analysed', () => {
    const p = scanZipBuffer(zip({ 'big.js': 'a'.repeat(100) }), 'x', resolveConfig({ maxFileSizeBytes: 10 }));
    expect(p.files[0].ignored).toBe(true);
  });
});

function zip(files: Record<string, string>): Buffer {
  const z = new AdmZip();
  for (const [k, v] of Object.entries(files)) z.addFile(k, Buffer.from(v));
  return z.toBuffer();
}
