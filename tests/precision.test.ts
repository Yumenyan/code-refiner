import { describe, expect, it } from 'vitest';
import { run, text } from './helpers/util.js';

const go = async (files: Record<string, string>, mode: 'safe' | 'cautious' | 'aggressive', extra = {}) => run(files, { mode, ...extra });
const one = async (src: string, mode: 'safe' | 'cautious' | 'aggressive', name = 'a.js', extra = {}) => text(await go({ [name]: src }, mode, extra), name);

describe('let → const', () => {
  it('converts never-reassigned let (SAFE) but not reassigned ones', async () => {
    const code = await one(`function f(){ let a = 1; let b = 2; b++; let c; c = 3; for (let i = 0; i < 3; i++) {} for (let k of [1]) {} return a + b + c; }`, 'safe');
    expect(code).toContain('const a = 1');
    expect(code).toContain('let b = 2');
    expect(code).toContain('let c;');
    expect(code).toContain('let i = 0');
    expect(code).toContain('const k of');
  });
});

describe('string concatenation → template literal', () => {
  it('converts chains that are certainly string concatenations', async () => {
    const code = await one(`const a = 'x' + y + 'z'; const b = n + ' items'; const c = '<li class="' + cls + '">' + t + '</li>';`, 'cautious');
    expect(code).toContain('`x${y}z`');
    expect(code).toContain('`${n} items`');
    expect(code).toContain('`<li class="${cls}">${t}</li>`');
  });
  it('never touches numeric additions or the coercion idiom', async () => {
    const code = await one(`const a = 1 + 2 + 'x'; const b = x + y + 'z'; const c = '' + n; const d = n + '';`, 'cautious');
    expect(code).toContain("1 + 2 + 'x'");
    expect(code).toContain("x + y + 'z'");
    expect(code).toContain("'' + n");
    expect(code).toContain("n + ''");
  });
  it('escapes backticks, ${ and backslashes and keeps newlines as \\n', async () => {
    const code = await one('const a = "`${x}\\\\" + v + "\\n";', 'cautious');
    const fn = new Function('v', `${code.replace(/^const a = /, 'return ')}`);
    expect(fn('V')).toBe('`${x}\\' + 'V' + '\n');
  });
  it('is CAUTIOUS only', async () => {
    expect(await one(`const a = 'x' + y;`, 'safe')).toContain("'x' + y");
  });
});

describe('index loop → for…of (AGGRESSIVE)', () => {
  it('converts a plain read loop and names the element after the collection', async () => {
    const code = await one(`function f(stations){ var out = ''; for (var i = 0; i < stations.length; i++) { out += stations[i].name; } return out; }`, 'aggressive');
    expect(code).toMatch(/for \(const station of stations\)/);
    expect(code).toContain('station.name');
    expect(await one(`function f(stations){ for (var i = 0; i < stations.length; i++) { use(stations[i]); } }`, 'cautious')).toContain('var i');
  });
  it('refuses when the index is used for anything else, or the array is modified, or closures capture it', async () => {
    const cases = [
      `function f(a){ for (var i = 0; i < a.length; i++) { use(a[i], i); } }`,
      `function f(a){ for (var i = 0; i < a.length; i++) { a[i] = 0; } }`,
      `function f(a){ for (var i = 0; i < a.length; i++) { if (a[i]) a.push(1); } }`,
      `function f(a){ for (var i = 0; i < a.length; i++) { setTimeout(function(){ use(a[i]); }); } }`,
      `function f(a){ for (var i = 0; i < a.length; i++) { a[i](); } }`,
      `function f(a){ for (var i = 1; i < a.length; i++) { use(a[i]); } }`,
      `function f(a){ for (var i = 0; i < a.length; i += 2) { use(a[i]); } }`,
      `function f(a){ for (var i = 0; i < a.length; i++) { use(a[i]); } return i; }`,
    ];
    for (const src of cases) expect(await one(src, 'aggressive'), src).toMatch(/for \((var|let) i/);
  });
  it('the result behaves the same', async () => {
    const src = `function f(items){ var t = 0; for (var i = 0; i < items.length; i++) { t += items[i].price * items[i].qty; } return t; }\nmodule.exports = f;`;
    const code = await one(src, 'aggressive', 'a.cjs');
    const run1 = (s: string) => { const m = { exports: {} as unknown }; new Function('module', s)(m); return (m.exports as (x: unknown) => number)([{ price: 2, qty: 3 }, { price: 5, qty: 1 }]); };
    expect(run1(code)).toBe(run1(src));
  });
});

describe('classic-script globals (renameGlobals)', () => {
  const src = `var x = stations.filter(s => s.active);\nfunction f(){ return x.length; }\nvar stations = [];`;
  it('are never renamed in SAFE / CAUTIOUS mode', async () => {
    for (const mode of ['safe', 'cautious'] as const) {
      const code = await one(src, mode);
      expect(code).toMatch(/var x\b/);
    }
  });
  it('are renamed in AGGRESSIVE mode when nothing else references them', async () => {
    const r = await go({ 'a.js': src }, 'aggressive');
    const code = text(r, 'a.js');
    expect(code).toContain('activeStations');
    expect(r.validation.rolledBack).toEqual([]);
    expect(r.changes.find((c) => c.kind === 'rename' && c.before === 'x')?.description).toMatch(/global/);
  });
  it('are protected when another file, an inline handler or window.x uses them', async () => {
    const files = {
      'a.js': src,
      'b.js': `console.log(x);`,
      'index.html': '<script src="a.js"></script><script src="b.js"></script>',
    };
    expect(text(await go(files, 'aggressive'), 'a.js')).toMatch(/var x\b|let x\b|const x\b/);
    expect(text(await go({ 'a.js': src + '\nwindow.x;' }, 'aggressive'), 'a.js')).toMatch(/\b(var|const|let) x\b/);
    expect(text(await go({ 'a.js': src, 'i.html': '<button onclick="x.go()">x</button>' }, 'aggressive'), 'a.js')).toMatch(/\b(var|const|let) x\b/);
    expect(text(await go({ 'a.js': src + "\nwindow['x'];" }, 'aggressive'), 'a.js')).toMatch(/\b(var|const|let) x\b/);
  });
  it('can be switched off explicitly', async () => {
    const code = await one(src, 'aggressive', 'a.js', { renameGlobals: 'never' });
    expect(code).toMatch(/var x\b/);
  });
  it('top-level var of a classic script becomes const only when private', async () => {
    expect(await one(`var a = 1; function f(){ return a; }`, 'cautious')).toContain('var a');
    expect(await one(`var a = 1; function f(){ return a; }`, 'aggressive')).toContain('const a');
  });
});

describe('function and variable names from wiring and data flow', () => {
  const app = `var todos = [];
function f1(e) { var v = document.getElementById('todo-input').value; todos.push(v); draw(); }
function draw() { var el = document.getElementById('todo-list'); var h = ''; todos.forEach(function (t) { h += '<li>' + t + '</li>'; }); el.innerHTML = h; }
function addTodo(t) { var o = {}; o.text = t; todos.push(o); return o; }
function getDone() { var res = []; for (var i = 0; i < todos.length; i++) { if (todos[i].done) { res.push(todos[i]); } } return res; }
document.getElementById('add-btn').addEventListener('click', f1);`;
  it('derives names from event wiring, rendering, DOM ids, sinks and manual filters', async () => {
    const code = await one(app, 'aggressive');
    expect(code).toContain('function handleAddButtonClick(');
    expect(code).toMatch(/const todoInputValue = document\.getElementById\(["']todo-input["']\)\.value/);
    expect(code).toMatch(/const todoList = document\.getElementById/);
    expect(code).toMatch(/let html = ''|let html = ""/);
    expect(code).toContain('doneTodos.push(');
    expect(code).toMatch(/const todo = \{\}/);
  });
  it('SAFE mode leaves all of those alone', async () => {
    const code = await one(app, 'safe');
    expect(code).toContain('function f1(');
    expect(code).not.toContain('handleAddButtonClick');
  });
  it('functions that HTML calls are never renamed', async () => {
    const r = await go({ 'a.js': `function f1(){ return 1; }`, 'i.html': '<button onclick="f1()">x</button><script src="a.js"></script>' }, 'aggressive');
    expect(text(r, 'a.js')).toContain('function f1');
  });
});

describe('Japanese code', () => {
  it('handles Japanese identifiers, comments and strings', async () => {
    const src = `// 駅の一覧\nfunction 絞り込み(駅一覧) {\n  const x = 駅一覧.filter((s) => s.active);\n  return x.length > 0 ? "あり" : "なし";\n}\nexport { 絞り込み };\n`;
    const r = await go({ 'a.js': src }, 'aggressive');
    const code = text(r, 'a.js');
    expect(code).toContain('// 駅の一覧');
    expect(code).toContain('"あり"');
    expect(code).not.toMatch(/const x\b/);
    const created = r.changes.filter((c) => c.kind === 'rename').map((c) => c.after!);
    for (const n of created) expect(/^[\p{ID_Start}_$][\p{ID_Continue}$]*$/u.test(n)).toBe(true);
  });
});
