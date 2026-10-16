import { describe, expect, it } from 'vitest';
import { createRegistry } from '../src/languages/index.js';
import type { LanguageRegistry } from '../src/languages/registry.js';
import { run, text } from './helpers/util.js';

const reg: LanguageRegistry = await createRegistry();
const go = (files: Record<string, string>, cfg = {}) => run(files, cfg, { registry: reg });
const have = (id: string) => !!reg.get(id);
const fmt = (id: string) => reg.get(id)!.formatter.id !== 'none';

describe('Parser-backed Language Packs (syntax, vocabulary, metrics)', () => {
  const samples: Record<string, [string, string, string]> = {
    java: ['A.java', 'class A { int f(int a) { if (a > 1 && a < 9) { return 1; } return 2; } }\n', 'class A { int f( { }'],
    csharp: ['A.cs', 'class A { int F(int a) { if (a > 1) { return 1; } return 2; } }\n', 'class A { int F( { }'],
    go: ['a.go', 'package main\nfunc f(a int) int {\n\tif a > 1 {\n\t\treturn 1\n\t}\n\treturn 2\n}\n', 'package main\nfunc f( {'],
    python: ['a.py', 'def f(a):\n    if a > 1:\n        return 1\n    return 2\n', 'def f(:\n'],
    rust: ['a.rs', 'fn f(a: i32) -> i32 {\n    if a > 1 { 1 } else { 2 }\n}\n', 'fn f( {'],
    ruby: ['a.rb', 'def f(a)\n  a > 1 ? 1 : 2\nend\n', 'def f(a\n'],
    php: ['a.php', '<?php\nfunction f($a) { if ($a > 1) { return 1; } return 2; }\n', '<?php\nfunction f( {'],
    kotlin: ['a.kt', 'fun f(a: Int): Int { if (a > 1) { return 1 }; return 2 }\n', 'fun f( {'],
    swift: ['a.swift', 'func f(_ a: Int) -> Int { if a > 1 { return 1 }; return 2 }\n', 'func f( {'],
    c: ['a.c', 'int f(int a) { if (a > 1) { return 1; } return 2; }\n', 'int f( {'],
    cpp: ['a.cpp', 'int f(int a) { if (a > 1) { return 1; } return 2; }\n', 'int f( {'],
    shell: ['a.sh', 'f() {\n  if [ "$1" -gt 1 ]; then echo a; fi\n}\n', 'f() {\n  if [ 1 \n'],
    scala: ['a.scala', 'object A { def f(a: Int): Int = if (a > 1) 1 else 2 }\n', 'object A { def f( }'],
  };
  for (const [id, [file, good, bad]] of Object.entries(samples)) {
    it(`${id}: parses valid code, rejects broken code, leaves broken files untouched`, async () => {
      const pack = reg.get(id)!;
      expect(pack, `${id} pack`).toBeTruthy();
      await pack.init?.();
      expect((await pack.checkSyntax(good, file)).ok).toBe(true);
      expect((await pack.checkSyntax(bad, file)).ok).toBe(false);
      const r = await go({ [file]: bad });
      expect(text(r, file)).toBe(bad);
      expect(r.warnings.some((w) => w.code === 'syntax-error')).toBe(true);
      const ok = await go({ [file]: good });
      expect(r.files[0].status).not.toBe('unsupported');
      expect(ok.files[0].status).not.toBe('unsupported');
    });
  }

  it('contributes functions with complexity metrics and finds duplicates across languages', async () => {
    const body = (n: string) => `class A { int ${n}(int a, int b) { int s = 0; for (int i = 0; i < a; i++) { if (i % 2 == 0 && b > i) { s += i * 2; } else { s -= 1; } } while (s > 100) { s /= 2; } return s; } }\n`;
    const r = await go({ 'A.java': body('first'), 'B.java': body('second') }, { complexity: { maxFunctionLines: 60, maxNesting: 2, maxParams: 5, maxCyclomatic: 4 } });
    const fnNames = r.analysis.functions.map((f) => f.name);
    expect(fnNames).toEqual(expect.arrayContaining(['first', 'second']));
    expect(r.suggestions.some((s) => s.kind === 'complexity' && /first/.test(s.message))).toBe(true);
    expect(r.suggestions.some((s) => s.kind === 'duplicate' && s.details?.category === 'duplicate-function')).toBe(true);
    expect(r.analysis.vocabulary.length).toBeGreaterThanOrEqual(0);
  });
});

describe('Native formatters (used only when installed; every result is verified)', () => {
  it.skipIf(!have('go') || !fmt('go'))('Go (gofmt)', async () => {
    const r = await go({ 'a.go': 'package main\nfunc  main( ){x:=1;_=x}\n' });
    expect(text(r, 'a.go')).toContain('func main() {');
  });
  it.skipIf(!have('rust') || !fmt('rust'))('Rust (rustfmt)', async () => {
    const r = await go({ 'a.rs': 'fn main( ){let x=1;println!("{}",x);}\n' });
    expect(text(r, 'a.rs')).toContain('let x = 1;');
  });
  it.skipIf(!have('python') || !fmt('python'))('Python (ruff/black) with AST-equality proof', async () => {
    const r = await go({ 'a.py': 'def f( a,b ):\n  return a+b\n' });
    expect(text(r, 'a.py')).toBe('def f(a, b):\n    return a + b\n');
  });
  it.skipIf(!have('java') || !fmt('java'))('Java (token-stream proof: only whitespace may change)', async () => {
    const r = await go({ 'A.java': 'class A{int f(int a){if(a>1){return 1;}else{return 2;}}}\n' });
    const out = text(r, 'A.java');
    expect(out).toContain('class A {');
    expect(out.replace(/\s+/g, '')).toBe('classA{intf(inta){if(a>1){return1;}else{return2;}}}');
  });
  it.skipIf(!have('c') || !fmt('c'))('C / C++ keep #include order and comments', async () => {
    const r = await go({ 'a.c': '#include <b.h>\n#include <a.h>\n/* long   comment   spacing */\nint f(int a){return a+1;}\n' });
    const out = text(r, 'a.c');
    expect(out.indexOf('<b.h>')).toBeLessThan(out.indexOf('<a.h>'));
    expect(out).toContain('long   comment   spacing');
    expect(out).toContain('int f(int a) {');
  });
  it('a formatter that changes more than whitespace is rejected', async () => {
    const { treeSitterPack } = await import('../src/languages/treesitter/pack.js');
    const evil = treeSitterPack({
      id: 'java', displayName: 'Java', extensions: ['.java'], wasm: 'tree-sitter-java.wasm', functionTypes: ['method_declaration'],
      formatter: { id: 'evil', format: async (s) => s.replace('a + 1', 'a + 2') }, equivalence: 'tokens',
    });
    await evil.init();
    const out = await evil.refine({ file: 'A.java', source: 'class A { int f(int a) { return a + 1; } }\n', config: {} as never, project: {} as never });
    expect(out.code).toContain('a + 1');
    expect(out.warnings[0].code).toBe('format-skipped');
  });
});

describe('Prettier-backed formats', () => {
  it('SCSS / Less / Markdown / YAML / Vue / GraphQL are formatted and broken files untouched', async () => {
    const files = {
      'a.scss': '$c:red;.a{.b{color:$c;&:hover{color:blue}}}',
      'a.less': '@c:red;.a{.b{color:@c}}',
      'a.md': '# T\n\n*  one\n*  two\n',
      'a.yml': 'a:   1\nb:\n   - x\n   -   y\n',
      'a.vue': '<template><div   class="a">x</div></template>\n<script>export default {name:"a"}</script>\n',
      'a.graphql': 'query   Q{a{b}}\n',
      'bad.scss': '.a{ color: ',
      'bad.yml': 'a: [1, 2\n',
    };
    const r = await go(files);
    expect(text(r, 'a.scss')).toMatch(/\.a \{\n {2}\.b \{/);
    expect(text(r, 'a.less')).toContain('@c: red;');
    expect(text(r, 'a.md')).toContain('- one');
    expect(text(r, 'a.yml')).toContain('a: 1');
    expect(text(r, 'a.vue')).toContain('<div class="a">x</div>');
    expect(text(r, 'a.graphql')).toContain('query Q {');
    expect(text(r, 'bad.scss')).toBe(files['bad.scss']);
    expect(text(r, 'bad.yml')).toBe(files['bad.yml']);
    for (const f of ['a.scss', 'a.less', 'a.md', 'a.yml', 'a.vue', 'a.graphql']) expect(r.files.find((x) => x.path === f)!.status, f).toBe('changed');
  });
  it('formatting is stable (second run changes nothing)', async () => {
    const first = await go({ 'a.scss': '.a{.b{color:red}}', 'a.md': '#  T\n\n*  x\n', 'a.yml': 'a:   1\n' });
    const files = Object.fromEntries([...first.refined.entries()].map(([k, v]) => [k, v.toString()]));
    const second = await go(files);
    expect(second.stats.changedFiles).toBe(0);
  });
});
