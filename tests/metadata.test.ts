import { describe, expect, it } from 'vitest';
import { detectMetadata } from '../src/core/metadata.js';
import { memProject } from './helpers/util.js';

const detect = (files: Record<string, string>) => {
  const p = memProject(files);
  return detectMetadata(p, (path) => p.files.find((f) => f.path === path)?.data?.toString('utf8'), new Set(['html', 'css', 'javascript', 'typescript', 'json']));
};

describe('Language / framework detection', () => {
  it('detects a Vite browser project', () => {
    const m = detect({
      'package.json': JSON.stringify({ name: 'demo', scripts: { build: 'vite build', test: 'vitest' }, devDependencies: { vite: '^5', vitest: '1' }, dependencies: { react: '18' } }),
      'vite.config.js': 'export default {}',
      'index.html': '<script type="module" src="/src/main.js"></script>',
      'src/main.js': 'console.log(1)',
      'src/style.css': 'a{}',
    });
    expect(m.runtime).toBe('browser');
    expect(m.languages).toEqual(expect.arrayContaining(['html', 'css', 'javascript']));
    expect(m.frameworks).toEqual(expect.arrayContaining(['react']));
    expect(m.buildTools).toContain('vite');
    expect(m.testRunners).toContain('vitest');
    expect(m.entryPoints).toEqual(expect.arrayContaining(['index.html', 'src/main.js']));
    expect(m.validationCommands.map((c) => c.command)).toEqual(['npm run build', 'npm test']);
  });

  it('detects node + typescript and unsupported languages', () => {
    const m = detect({
      'package.json': JSON.stringify({ name: 'api', main: 'dist/x.js', dependencies: { express: '4' }, scripts: { typecheck: 'tsc --noEmit' } }),
      'tsconfig.json': '{}',
      'src/server.ts': 'export {}',
      'tool.py': 'print(1)',
      'Cargo.toml': '[package]',
      'src/lib.rs': 'fn main(){}',
    });
    expect(m.runtime).toBe('node');
    expect(m.typescript).toBe(true);
    expect(m.tsconfig).toBe('tsconfig.json');
    expect(m.frameworks).toContain('express');
    expect(m.unsupportedLanguages).toEqual(expect.arrayContaining(['rust']));
    expect(m.validationCommands.map((c) => c.kind)).toEqual(expect.arrayContaining(['typecheck', 'build', 'test']));
  });
});
