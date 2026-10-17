import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createRegistry } from '../src/languages/index.js';
import { run, text } from './helpers/util.js';

const exec = promisify(execFile);
const ROOT = join(import.meta.dirname, '..');
const reg = await createRegistry({ native: false }); // the browser-like setup: only built-in layout, no native tools
const go = (files: Record<string, string>, cfg: Record<string, unknown> = {}) => run(files, { mode: 'cautious', ...cfg }, { registry: reg });
const lineCount = (s: string) => s.split('\n').length;

describe('Built-in layout for brace languages (no native formatter needed)', () => {
  const minified: Record<string, [string, string]> = {
    'a.rs': ['fn main(){let x=1;if x>0{println!("a");}else{println!("b");}}', 'fn main() {'],
    'A.java': ['class A{int f(int a){if(a>1){return 1;}return 2;}}', 'class A {'],
    'A.cs': ['class A{int F(int a){if(a>1){return 1;}return 2;}}', 'class A {'],
    'a.c': ['int f(int a){if(a>1){return 1;}return 2;}', 'int f(int a) {'],
    'a.cpp': ['int f(int a){for(int i=0;i<a;i++){a+=i;}return a;}', 'int f(int a) {'],
    'a.go': ['package main\nfunc f(a int) int {if a>1 {return 1};return 2}', 'func f(a int) int {'],
    'a.kt': ['fun f(a: Int): Int { if (a > 1) { return 1 }; return 2 }', 'fun f(a: Int): Int {'],
    'a.scala': ['object A { def f(a: Int): Int = { if (a > 1) 1 else 2 } }', 'object A {'],
  };
  for (const [file, [src, expected]] of Object.entries(minified)) {
    it(`${file}: expands one-liners into readable, indented lines`, async () => {
      const r = await go({ [file]: src }, { renameVariables: false });
      const out = text(r, file);
      expect(lineCount(out)).toBeGreaterThan(lineCount(src) + 2);
      expect(out).toContain(expected);
      expect(r.files[0].status).toBe('changed');
      // idempotent
      const again = await go({ [file]: out }, { renameVariables: false });
      expect(again.stats.changedFiles).toBe(0);
    });
  }

  it('only whitespace changes: comments, strings, preprocessor lines and attributes are untouched', async () => {
    const src = `#include <stdio.h>\n#define MAX(a,b) ((a)>(b)?(a):(b))\n/* keep   this\n   comment */\nint main(){char*s="a;  b{ }";// trailing ; { }\nreturn 0;}`;
    const out = text(await go({ 'a.c': src }, { renameVariables: false }), 'a.c');
    expect(out).toContain('#define MAX(a,b) ((a)>(b)?(a):(b))');
    expect(out).toContain('"a;  b{ }"');
    expect(out).toContain('// trailing ; { }');
    expect(out).toContain('/* keep   this');
    const strip = (s: string) => s.replace(/\s+/g, '');
    expect(strip(out)).toBe(strip(src));
  });

  it('keeps `for (;;)` headers, struct literals and closures on one line', async () => {
    const out = text(await go({ 'a.rs': 'fn f(){let s=Foo{a:1,b:2};let c=|x:i32|{x+1};for i in 0..3{g(i);}}' }, { renameVariables: false }), 'a.rs');
    expect(out).toContain('Foo {a: 1, b: 2}');
    expect(out).toMatch(/\|x: i32\| ?\{x\+1\}/);
    const j = text(await go({ 'A.java': 'class A{void f(){for(int i=0;i<3;i++){g(i);}int[] a={1,2,3};}}' }, { renameVariables: false }), 'A.java');
    expect(j).toMatch(/for \(int i = 0; i<3; i\+\+\) \{/);
    expect(j).toContain('{1, 2, 3}');
  });
});

describe('Rust refactoring', () => {
  const rust = `struct Station { name: String, active: bool, price: u32 }
fn names(stations: &Vec<Station>) -> Vec<String> {
    let x = stations.iter().filter(|s| s.active).collect::<Vec<_>>();
    let mut out = Vec::new();
    for s in x.iter() { out.push(s.name.clone()); }
    let cnt = out.len();
    if (cnt == 0) { return out; }
    if out.is_empty() == true { println!("none {}", cnt); }
    return out;
}`;
  it('renames from iterator chains and loops, keeping snake_case', async () => {
    const r = await go({ 'a.rs': rust });
    const out = text(r, 'a.rs');
    expect(out).toContain('let active_stations = stations.iter().filter(|station| station.active)');
    expect(out).toContain('for active_station in active_stations.iter()');
    expect(out).toContain('let count = out.len()');
    expect(r.warnings).toEqual([]);
  });
  it('applies safe language rules: tail return, bool comparisons, redundant parentheses', async () => {
    const out = text(await go({ 'a.rs': rust }, { renameVariables: false }), 'a.rs');
    expect(out).not.toMatch(/return out;\s*\}\s*$/);
    expect(out.trimEnd().split('\n').slice(-2)[0].trim()).toBe('out');
    expect(out).toContain('if out.is_empty() {');
    expect(out).toContain('if cnt == 0 {');
  });
  it('does not touch what it cannot prove: shadowing, struct shorthand, format captures, unknown macros, early returns', async () => {
    const cases = [
      `fn f(items: &Vec<i32>) -> i32 { let x = 1; let x = x + 1; x }`,
      `fn f() -> Foo { let x = 1; Foo { x } }`,
      `fn f() { let x = 1; println!("{x}"); }`,
      `fn f() { let x = 1; mystery!(x); }`,
      `fn f(a: bool) -> i32 { if a { return 1; } 2 }`,
    ];
    for (const src of cases) {
      const out = text(await go({ 'a.rs': src }), 'a.rs');
      expect(out.replace(/\s+/g, ''), src).toBe(src.replace(/\s+/g, ''));
    }
  });
  it('struct fields named like locals are left alone', async () => {
    const out = text(await go({ 'a.rs': `struct S { x: i32 }\nimpl S { fn f(&self, items: &Vec<S>) { let x = items.len(); println!("{}", self.x + x as i32); } }` }), 'a.rs');
    expect(out).toContain('self.x');
  });
});

describe('Java / C# / Go / Python renames', () => {
  it('Java', async () => {
    const out = text(await go({ 'A.java': 'class A { int f(List<Station> stations) { List<Station> x = stations.stream().filter(s -> s.isActive()).collect(Collectors.toList()); int cnt = 0; for (Station st : x) { cnt++; } return cnt; } }' }), 'A.java');
    expect(out).toContain('List<Station> activeStations = stations.stream().filter(station -> station.isActive())');
    expect(out).toContain('int count = 0;');
  });
  it('C#', async () => {
    const out = text(await go({ 'A.cs': 'class A { int F(List<Station> stations) { var x = stations.Where(s => s.Active).ToList(); int cnt = 0; foreach (var s in x) { cnt++; } return cnt; } }' }), 'A.cs');
    expect(out).toContain('var activeStations = stations.Where(station => station.Active).ToList();');
    expect(out).toContain('foreach (var activeStation in activeStations)');
  });
  it('Go (camelCase) and the bool comparison rule', async () => {
    const out = text(await go({ 'a.go': 'package main\nfunc f(stations []Station) int {\n\tfor _, s := range stations {\n\t\tif s.Active == true {\n\t\t\tprintln(s.Name)\n\t\t}\n\t}\n\treturn 0\n}\n' }), 'a.go');
    expect(out).toContain('for _, station := range stations');
    expect(out).toContain('if station.Active {');
  });
  it('Python (snake_case) incl. list comprehensions and kwargs / attributes are not renamed', async () => {
    const out = text(await go({ 'a.py': 'def f(stations):\n    x = [s.name for s in stations if s.active]\n    cnt = len(x)\n    if (cnt == 0):\n        return None\n    print(x, sep=cnt)\n    return x\n' }), 'a.py');
    expect(out).toContain('active_stations = [station.name for station in stations if station.active]');
    expect(out).toContain('count = len(active_stations)');
    expect(out).toContain('if count == 0:');
    expect(out).toContain('sep=count'); // the keyword name `sep` is untouched
  });
  it('SAFE mode needs 95%: nothing is renamed, candidates are reported', async () => {
    const r = await go({ 'a.rs': 'fn f(stations: &Vec<S>) { let x = stations.iter().filter(|s| s.active).count(); println!("{}", x); }' }, { mode: 'safe' });
    expect(text(r, 'a.rs')).toContain('let x =');
    expect(r.suggestions.some((s) => s.kind === 'rename' && s.details?.applied === false)).toBe(true);
  });
  it('an AI proposal renames Rust identifiers too (validated like any other name)', async () => {
    const advisor = { id: 'm', adviseName: async () => ({ choice: null, proposal: 'visible_count' }) };
    const { refineProject } = await import('../src/pipeline.js');
    const { memProject } = await import('./helpers/util.js');
    const r = await refineProject(memProject({ 'a.rs': 'fn f(v: &Vec<i32>) -> usize { let q = v.iter().filter(|a| **a > 0).count(); q + q }' }), { mode: 'safe', aiAdvisor: true }, { advisor, registry: reg });
    expect(text(r as never, 'a.rs')).toContain('visible_count');
  });
});

describe('Extension mapping and content detection', () => {
  const js = `var items = [1,2];\nfunction f(a){ if (a > 1) { return true; } else { return false; } }\nconsole.log(f(items.length));\n`;
  it('treats unknown extensions as the language you map them to', async () => {
    const plain = await go({ 'a.rhino': js });
    expect(text(plain, 'a.rhino')).toBe(js);
    expect(plain.files[0].status).toBe('unsupported');
    const mapped = await go({ 'a.rhino': js }, { languageMap: { '.rhino': 'javascript' } });
    expect(text(mapped, 'a.rhino')).toContain('return a > 1;');
    expect(mapped.files[0]).toMatchObject({ status: 'changed', language: 'javascript' });
  });
  it('can detect the language from the content when asked to', async () => {
    const files = { 'script.es': js, 'tool': '#!/usr/bin/env node\n' + js, 'lib.xyz': 'fn main(){let x=1;println!("{}",x);}\nfn g(a:i32)->i32{a+1}', 'notes.txt': js, 'data.dat': 'just some words here, nothing to see' };
    const off = await go(files);
    expect(off.files.filter((f) => f.status === 'changed')).toHaveLength(0);
    const on = await go(files, { detectLanguageByContent: true });
    const byPath = Object.fromEntries(on.files.map((f) => [f.path, f]));
    expect(byPath['script.es'].language).toBe('javascript');
    expect(byPath['tool'].language).toBe('javascript');
    expect(byPath['lib.xyz'].language).toBe('rust');
    expect(byPath['notes.txt'].status).not.toBe('changed'); // text files are never sniffed
    expect(byPath['data.dat'].status).not.toBe('changed');
    expect(text(on, 'lib.xyz')).toContain('fn main() {');
    expect(on.warnings.some((w) => w.code === 'language-sniffed')).toBe(true);
  });
  it('reports a mapping to a language that does not exist', async () => {
    const r = await go({ 'a.zz': 'x' }, { languageMap: { '.zz': 'klingon' } });
    expect(r.warnings.some((w) => w.code === 'language-map')).toBe(true);
  });
});

describe('Language level targets (ES3 / ES5 / Rhino ... latest)', () => {
  const modern = `const xs = [1, 2, 3,];\nlet total = 0;\nfor (let i = 0; i < xs.length; i++) { total += xs[i]; }\nconst msg = 'total: ' + total + '!';\nxs.forEach(function (x) { console.log(x + 1); });\nfunction f(a, b,) { return a + b; }\n`;
  const js = (target: string) => text(undefined as never, '') || target;
  void js;
  it('latest (default): modernises', async () => {
    const out = text(await go({ 'a.js': modern }, { mode: 'aggressive' }), 'a.js');
    expect(out).toContain('const msg = `total: ${total}!`');
    expect(out).toContain('=>');
  });
  it('ES5 / Rhino: no const, let, arrows, template literals, for…of, or trailing commas are introduced', async () => {
    for (const target of ['es5', 'rhino']) {
      const r = await go({ 'a.js': `var xs = [1, 2, 3];\nvar total = 0;\nfor (var i = 0; i < xs.length; i++) { total += xs[i]; }\nvar msg = 'total: ' + total + '!';\nxs.forEach(function (x) { console.log(x + 1); });\nfunction f(a, b) { return a + b; }\nvar o = {\n  a: 1,\n  b: 2\n};\n` }, { mode: 'aggressive', target: { javascript: target }, renameVariables: false });
      const out = text(r, 'a.js');
      expect(out, target).not.toMatch(/\b(const|let)\b/);
      expect(out, target).not.toContain('=>');
      expect(out, target).not.toContain('`');
      expect(out, target).not.toMatch(/for \(.* of /);
      expect(out, target).not.toMatch(/,\s*[\]}]/); // no trailing commas, even though Prettier's default adds them
      expect(out, target).toContain('function (x)');
    }
  });
  it('ES5: renames still work (they are not syntax)', async () => {
    const r = await go({ 'a.js': 'var stations = [];\nfunction f(){ var x = stations.filter(function (s) { return s.active; }); return x.length; }' }, { mode: 'cautious', target: { javascript: 'es5' } });
    expect(text(r, 'a.js')).toContain('var activeStations');
  });
  it('warns about syntax newer than the target but leaves it alone', async () => {
    const r = await go({ 'a.js': 'const f = (a) => `${a}`;\nclass A {}\nasync function g() { await 1; }\nlet o = { ...x };' }, { target: { javascript: 'rhino' } });
    const msgs = r.warnings.filter((w) => w.code === 'target-syntax').map((w) => w.message).join('\n');
    expect(msgs).toMatch(/arrow function/);
    expect(msgs).toMatch(/template literal/);
    expect(msgs).toMatch(/class/);
    expect(msgs).toMatch(/newer than the target rhino/);
    expect(text(r, 'a.js')).toContain('=>');
  });
  it('ES2015 allows const and arrows but not async', async () => {
    const out = text(await go({ 'a.js': 'var a = 1; function f(){ var b = 2; return b + b; }' }, { mode: 'cautious', target: { javascript: 'es2015' } }), 'a.js');
    expect(out).toContain('const b');
  });
  it('rejects unknown targets', async () => {
    await expect(go({ 'a.js': '1' }, { target: { javascript: 'es99' } })).rejects.toThrow(/Unknown ECMAScript target/);
  });
  it('TypeScript has its own level', async () => {
    const src = 'function f(x: number): number { var y = x; return y + y; }';
    expect(text(await go({ 'a.ts': src }, { mode: 'cautious', target: { typescript: 'es5' } }), 'a.ts')).toContain('var y');
    expect(text(await go({ 'a.ts': src }, { mode: 'cautious' }), 'a.ts')).toContain('const y');
  });
});

describe('Configurable thresholds', () => {
  const src = 'export function f(stations){ const x = stations.filter(s => s.active); return x.length + x.length; }';
  it('renameApplyThreshold decides what is applied', async () => {
    expect(text(await go({ 'a.js': src }, { renameApplyThreshold: 0.5 }), 'a.js')).toContain('activeStations');
    expect(text(await go({ 'a.js': src }, { renameApplyThreshold: 0.99 }), 'a.js')).toContain('const x =');
  });
  it('naming weights change the score', async () => {
    const low = await go({ 'a.js': src }, { namingWeights: { sourceMatch: 0 }, mode: 'cautious' });
    expect(text(low, 'a.js')).toContain('const x =');
  });
  it('thresholds.suggest controls which candidates are reported', async () => {
    const hi = await go({ 'a.js': src }, { thresholds: { autoApply: 0.99, recommend: 0.95, suggest: 0.9 }, mode: 'safe' });
    const lo = await go({ 'a.js': src }, { thresholds: { autoApply: 0.99, recommend: 0.9, suggest: 0.1 }, mode: 'safe' });
    const count = (r: typeof hi) => r.suggestions.filter((s) => s.kind === 'rename').reduce((n, s) => n + (s.candidates?.length ?? 0), 0);
    expect(count(lo)).toBeGreaterThan(count(hi));
  });
});

describe('CLI options', () => {
  it('--target, --map, --sniff, --threshold, --weight and --set reach the engine', async () => {
    await exec('npx', ['tsc', '-p', 'tsconfig.json'], { cwd: ROOT });
    const dir = await mkdtemp(join(tmpdir(), 'cr-cli2-'));
    const input = join(dir, 'proj');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(input);
    await writeFile(join(input, 'a.rhino'), 'var stations = [];\nfunction f() { var x = stations.filter(function (s) { return s.active; }); var msg = "n: " + x.length; return msg; }\n');
    await writeFile(join(input, 'noext'), '#!/usr/bin/env node\nfunction g(a){ if (a) { return true; } else { return false; } }\nconsole.log(g(1));\n');
    const cli = join(ROOT, 'dist/cli.js');
    await exec('node', [cli, input, '-o', join(dir, 'out'), '--mode', 'aggressive', '--target', 'rhino', '--map', '.rhino=javascript', '--sniff', '--threshold', 'apply=0.7', '--weight', 'sourceMatch=35', '--set', 'complexity.maxNesting=2', '-q'], { cwd: dir });
    const a = await readFile(join(dir, 'out/refined/a.rhino'), 'utf8');
    expect(a).toContain('var activeStations');
    expect(a).not.toContain('`');
    expect(await readFile(join(dir, 'out/refined/noext'), 'utf8')).toContain('return Boolean(a)');
    const report = JSON.parse(await readFile(join(dir, 'out/report.json'), 'utf8'));
    expect(report.config.target).toEqual({ javascript: 'rhino', typescript: 'rhino' });
    expect(report.config.complexity.maxNesting).toBe(2);
    expect(report.config.renameApplyThreshold).toBe(0.7);
    expect(report.config.namingWeights.sourceMatch).toBe(35);
    await expect(exec('node', [cli, input, '--threshold', 'bogus=1'], { cwd: dir })).rejects.toBeTruthy();
    await expect(exec('node', [cli, input, '--target', 'javascript=es99'], { cwd: dir })).rejects.toBeTruthy();
  }, 90_000);
});
