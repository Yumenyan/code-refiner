import { describe, expect, it } from 'vitest';
import { run, text } from './helpers/util.js';

const refine = async (src: string, mode: 'safe' | 'cautious' | 'aggressive' = 'safe', extra = {}, name = 'a.js') => {
  const r = await run({ [name]: src }, { mode, renameVariables: false, ...extra });
  return { code: text(r, name), r };
};

describe('Safe refactoring: JavaScript rules', () => {
  it('if/else returning booleans becomes a direct return (obvious booleans only)', async () => {
    const { code } = await refine(`function f(a){ if (a > 1) { return true; } else { return false; } }`);
    expect(code).toContain('return a > 1;');
  });

  it('does NOT change `if (x) return true; else return false` for a non-boolean x in SAFE mode', async () => {
    const { code } = await refine(`function f(x){ if (x) { return true; } else { return false; } }`);
    expect(code).toContain('if (x)');
    expect(code).not.toContain('return x;');
  });

  it('wraps non-boolean conditions in Boolean() only in CAUTIOUS mode', async () => {
    const { code } = await refine(`function f(x){ if (x) { return true; } else { return false; } }`, 'cautious');
    expect(code).toContain('return Boolean(x);');
  });

  it('handles the negated form and the fall-through form', async () => {
    const a = await refine(`function f(x){ if (x === 1) return false; else return true; }`);
    expect(a.code).toContain('return x !== 1;');
    const b = await refine(`function f(a, b){ if (a < b) { return true; } return false; }`);
    expect(b.code).toContain('return a < b;');
  });

  it('leaves non-boolean returns alone', async () => {
    const { code } = await refine(`function f(a){ if (a) { return 1; } else { return 0; } }`);
    expect(code).toContain('return 1');
    expect(code).toContain('return 0');
  });

  it('simplifies c ? true : false only for booleans', async () => {
    const { code } = await refine(`const a = x > 1 ? true : false; const b = y ? true : false; const c = y ? false : true;`);
    expect(code).toContain('const a = x > 1;');
    expect(code).toContain('const b = y ? true : false;');
    expect(code).toContain('const c = !y;');
  });

  it('removes !! in conditions but keeps it where the value is used', async () => {
    const { code } = await refine(`if (!!a && !!b) { go(); } const v = !!a; while (!!c) { step(); }`);
    expect(code).toContain('if (a && b)');
    expect(code).toContain('const v = !!a;');
    expect(code).toContain('while (c)');
  });

  it('collapses else { if } into else if', async () => {
    const { code } = await refine(`if (a) { x(); } else { if (b) { y(); } }`);
    expect(code).toMatch(/else if \(b\)/);
  });

  it('inlines obvious temporary variables before return, but not when used twice', async () => {
    const a = await refine(`function f(){ const r = compute(); return r; }`);
    expect(a.code).toContain('return compute();');
    const b = await refine(`function f(){ const r = compute(); log(r); return r; }`);
    expect(b.code).toContain('const r = compute();');
    const c = await refine(`function f(){ let r = compute(); r = r + 1; return r; }`);
    expect(c.code).toContain('let r = compute();');
  });

  it('merges duplicate imports without touching side-effect imports', async () => {
    const { code } = await refine(`import { a } from './x.js';\nimport './side.js';\nimport { b } from './x.js';\nimport * as ns from './y.js';\nuse(a, b, ns);`);
    expect(code).toMatch(/import \{ a, b \} from ['"]\.\/x\.js['"]/);
    expect(code).toContain('./side.js');
    expect(code.match(/\.\/x\.js/g)).toHaveLength(1);
  });

  it('removes stray empty statements', async () => {
    const { code } = await refine(`function f(){ ;; return 1; };`);
    expect(code).not.toMatch(/;;/);
  });

  it('else-after-return and var->let/const are CAUTIOUS only', async () => {
    const src = `function f(a){ if (a) { return 1; } else { var z = 2; use(z); return z; } }`;
    const safe = await refine(src, 'safe');
    expect(safe.code).toContain('else');
    expect(safe.code).toContain('var z');
    const cautious = await refine(src, 'cautious');
    expect(cautious.code).not.toContain('else');
  });

  it('never converts `var` when it would change scoping', async () => {
    const { code } = await refine(
      `function f(c){ if (c) { var inner = 1; } return inner; }\n` +
        `function g(){ var k = 1; var k = 2; return k; }\n` +
        `function h(){ for (var i = 0; i < 3; i++) { setTimeout(function(){ use(i); }); } }\n` +
        `function u(){ use(late); var late = 1; }`,
      'cautious',
    );
    expect(code).toContain('var inner');
    expect(code).toContain('var k = 1');
    expect(code).toContain('var i = 0');
    expect(code).toContain('var late');
  });

  it('keeps top-level `var` of classic scripts (they are window properties)', async () => {
    const { code } = await refine(`var shared = 1; function f(){ return shared; }`, 'cautious');
    expect(code).toContain('var shared');
  });

  it('callback -> arrow is AGGRESSIVE only and respects `this`', async () => {
    const src = `a.map(function (x) { return x + 1; });\nb.on('e', function () { return this.v; });`;
    expect((await refine(src, 'cautious')).code).toContain('function');
    const code = (await refine(src, 'aggressive')).code;
    expect(code).toMatch(/a\.map\(\(x\) => x \+ 1\)|a\.map\(\(x\) => \{/);
    expect(code).toContain('function () {');
  });

  it('unused removal only happens when removeUnused is on, and keeps side effects', async () => {
    const src = `import { a, unused } from './m.js';\nimport side from './s.js';\nexport function f(){ const dead = 1; const keep = g(); return a; }`;
    const off = await refine(src, 'aggressive');
    expect(off.code).toContain('unused');
    const on = await refine(src, 'aggressive', { removeUnused: true }, 'mod.js');
    expect(on.code).not.toContain('unused');
    expect(on.code).not.toContain('dead');
    expect(on.code).toContain('g()');
    expect(on.code).toMatch(/import ['"]\.\/s\.js['"]/); // side effects preserved
  });

  it('removes unreachable statements (removeUnused) but keeps hoisted functions', async () => {
    const { code } = await refine(`function f(){ return 1; log('x'); function h(){} }`, 'cautious', { removeUnused: true });
    expect(code).not.toContain("log('x')");
    expect(code).not.toContain('log("x")');
    expect(code).toContain('function h');
  });

  it('keeps comments and original blank lines in untouched code (recast)', async () => {
    const { code } = await refine(`// header\nconst a = 1;\n\n\n/* keep */\nfunction f(){ if (a > 1) { return true; } return false; }\n`);
    expect(code).toContain('// header');
    expect(code).toContain('/* keep */');
  });

  it('is idempotent', async () => {
    const src = `var a = [1,2];\nfunction f(x){ if (x > 1) { return true } else { return false } }\nfunction g(list){ var s = list.filter(i => i.on); return s }`;
    const first = (await refine(src, 'cautious', { renameVariables: true })).code;
    const second = (await refine(first, 'cautious', { renameVariables: true })).code;
    expect(second).toBe(first);
  });

  it('files that do not parse are left byte-for-byte untouched and reported', async () => {
    const src = `function (( {`;
    const { code, r } = await refine(src);
    expect(code).toBe(src);
    expect(r.warnings.some((w) => w.code === 'syntax-error')).toBe(true);
  });

  it('supports TypeScript syntax', async () => {
    const { code } = await refine(`interface P { n: number }\nfunction f(p: P): boolean { if (p.n > 1) { return true; } else { return false; } }\nconst x = <T,>(a: T) => a;\n`, 'safe', {}, 'a.ts');
    expect(code).toContain('return p.n > 1;');
    expect(code).toContain('interface P');
  });

  it('supports JSX', async () => {
    const { code } = await refine(`const el = <div className="a">{items.map(i => <b key={i}>{i}</b>)}</div>;`, 'safe', {}, 'a.jsx');
    expect(code).toContain('<div className="a">');
  });
});
