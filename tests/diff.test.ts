import { describe, expect, it } from 'vitest';
import { diffFile, diffLines, diffText, unifiedDiff } from '../src/core/diff.js';

const apply = (ops: ReturnType<typeof diffLines>) => ({
  a: ops.filter((o) => o.type !== 'add').map((o) => o.line),
  b: ops.filter((o) => o.type !== 'del').map((o) => o.line),
});

describe('Diff Engine', () => {
  it('produces a correct edit script for random inputs', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let n = 0; n < 60; n++) {
      const a = Array.from({ length: Math.floor(rnd() * 25) }, () => String(Math.floor(rnd() * 6)));
      const b = Array.from({ length: Math.floor(rnd() * 25) }, () => String(Math.floor(rnd() * 6)));
      const r = apply(diffLines(a, b));
      expect(r.a).toEqual(a);
      expect(r.b).toEqual(b);
    }
  });

  it('counts added/removed lines and renders a unified diff', () => {
    const d = diffText('a\nb\nc\nd', 'a\nB\nc\nd\ne');
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
    const u = unifiedDiff({ path: 'f.txt', status: 'modified', ...d });
    expect(u).toContain('--- a/f.txt');
    expect(u).toContain('-b');
    expect(u).toContain('+B');
  });

  it('file level status', () => {
    expect(diffFile('x', 'a', 'a').status).toBe('unchanged');
    expect(diffFile('x', undefined, 'a').status).toBe('added');
    expect(diffFile('x', 'a', undefined).status).toBe('removed');
    expect(diffFile('x', 'a', 'b').status).toBe('modified');
  });
});
