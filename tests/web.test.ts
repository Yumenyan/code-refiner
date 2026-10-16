import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const ROOT = join(import.meta.dirname, '..');

describe('Static web build (GitHub Pages)', () => {
  it('builds a self-contained site that can run without Node built-ins', async () => {
    await exec('node', ['scripts/build-web.mjs'], { cwd: ROOT });
    for (const f of ['index.html', 'main.js', 'worker.js', '.nojekyll', 'wasm/tree-sitter.wasm', 'wasm/tree-sitter-java.wasm', 'wasm/tree-sitter-go.wasm']) {
      expect((await stat(join(ROOT, 'site', f))).isFile(), f).toBe(true);
    }
    const worker = await readFile(join(ROOT, 'site/worker.js'), 'utf8');
    // Static imports of Node built-ins would stop the module worker from loading at all.
    expect(worker).not.toMatch(/\bfrom\s*["']node:/);
    expect(worker).not.toMatch(/^import\s*["']node:/m);
    const html = await readFile(join(ROOT, 'site/index.html'), 'utf8');
    expect(html).toContain('src="main.js"'); // relative: works under /<repo>/ on GitHub Pages
    expect(html).not.toMatch(/(src|href)="\//);
  }, 60_000);
});
