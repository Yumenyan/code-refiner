import { describe, expect, it } from 'vitest';
import { diffText } from '../src/core/diff.js';
import { run } from './helpers/util.js';
import { createDefaultRegistry } from '../src/languages/index.js';
import { buildProjectModel, findCycles, callTree } from '../src/semantic/project.js';
import type { FileModels } from '../src/semantic/model.js';

const analyze = (files: Record<string, string>) => {
  const reg = createDefaultRegistry();
  const models = new Map<string, FileModels>();
  for (const [f, src] of Object.entries(files)) {
    const m = reg.forFile(f)?.analyze?.({ file: f, source: src });
    if (m) models.set(f, m);
  }
  return { models, model: buildProjectModel(models, new Set(Object.keys(files))) };
};

describe('Semantic analysis', () => {
  const src = `import { load } from './data.js';
const stations = load();
export function render(list) {
  const active = list.filter(s => s.active);
  return summarize(active);
}
function summarize(items) { return items.length; }
export function main() { render(stations); }
let unused = 1;
`;
  const { models, model } = analyze({ 'main.js': src, 'data.js': 'export function load(){ return []; }' });
  const sem = models.get('main.js')!.semantic!;

  it('captures variables with kind, type, init, references and scope', () => {
    const active = sem.variables.find((v) => v.name === 'active')!;
    expect(active).toMatchObject({ kind: 'const', valueType: 'array', scopeKind: 'function' });
    expect(active.references).toHaveLength(1);
    expect(active.init).toContain('list.filter');
    const stations = sem.variables.find((v) => v.name === 'stations')!;
    expect(stations.scopeKind).toBe('module');
    expect(sem.variables.find((v) => v.name === 'unused')!.references).toHaveLength(0);
    expect(sem.variables.find((v) => v.name === 'render')!.exported).toBe(true);
  });

  it('captures functions with params, calls and metrics', () => {
    const render = sem.functions.find((f) => f.name === 'render')!;
    expect(render.params).toEqual(['list']);
    expect(render.returnsValue).toBe(true);
    expect(render.exported).toBe(true);
    expect(render.calls.some((c) => c.includes('summarize'))).toBe(true);
    expect(sem.functions.find((f) => f.name === 'summarize')!.exported).toBe(false);
  });

  it('captures modules and resolves dependencies', () => {
    expect(sem.module.imports[0]).toMatchObject({ source: './data.js', specifiers: [{ imported: 'load', local: 'load' }] });
    expect(sem.module.exports.map((e) => e.name).sort()).toEqual(['main', 'render']);
    expect(model.dependencies).toContainEqual({ from: 'main.js', to: 'data.js', kind: 'import' });
  });

  it('builds a call graph (including calls across files) and data-flow edges', () => {
    const names = new Map(model.functions.map((f) => [f.id, f.name]));
    const edges = model.callGraph.map((c) => `${names.get(c.caller) ?? c.caller}->${names.get(c.callee) ?? c.callee}`);
    expect(edges).toContain('main->render');
    expect(edges).toContain('render->summarize');
    expect(edges.some((e) => e.endsWith('->load'))).toBe(true);
    const flow = model.dataFlow.map((d) => `${d.from.split('::')[1]?.split('@')[0] ?? d.from}->${d.to.split('::')[1]?.split('@')[0] ?? d.to}:${d.via}`);
    expect(flow).toContain('list->active:filter');
    expect(callTree(model, model.functions.find((f) => f.name === 'main')!.id).join('\n')).toContain('render');
  });

  it('detects circular dependencies', () => {
    const { model: m } = analyze({ 'a.js': `import './b.js'; export const a = 1;`, 'b.js': `import './a.js'; export const b = 2;`, 'c.js': `import './a.js';` });
    expect(m.cycles).toEqual([['a.js', 'b.js']]);
    expect(findCycles([{ from: 'x', to: 'x', kind: 'import' }])).toEqual([['x']]);
  });

  it('understands CommonJS require / module.exports', () => {
    const { models: ms } = analyze({ 'a.js': `const { b } = require('./b'); module.exports = { run() { return b; } };`, 'b.js': `exports.b = 1;` });
    expect(ms.get('a.js')!.semantic!.module.imports[0].source).toBe('./b');
    expect(ms.get('a.js')!.semantic!.module.exports.some((e) => e.kind === 'commonjs')).toBe(true);
  });
});

describe('Cross analysis HTML / CSS / JS', () => {
  const files = {
    'index.html': `<div id="app" class="box"><button id="go" class="btn" data-mode="x">go</button></div><button onclick="save()">s</button><button onclick="missing()">m</button><script src="app.js"></script>`,
    'style.css': `.box{color:red}.btn{color:blue}.ghost{color:green}#app{margin:0}#nothing{margin:0}@keyframes spin{from{opacity:0}}`,
    'app.js': `const b = document.getElementById('go'); b.addEventListener('click', onGo); function onGo(){ document.querySelector('.box').classList.add('open'); document.getElementById('absent'); var m = el.dataset.mode; } function save(){}`,
  };

  it('relates ids, classes, events and handlers; reports unused CSS and missing targets', async () => {
    const r = await run(files);
    const x = r.analysis.crossRef;
    const go = x.ids.find((i) => i.id === 'go')!;
    expect(go.html).toHaveLength(1);
    expect(go.js).toHaveLength(1);
    expect(go.events).toContainEqual(expect.objectContaining({ event: 'click', handler: 'onGo' }));
    expect(x.classes.find((c) => c.name === 'box')).toMatchObject({ html: 1 });
    expect(x.protectedNames).toEqual(expect.arrayContaining(['save', 'missing']));
    const msgs = r.suggestions.map((s) => s.message);
    expect(msgs.some((m) => m.includes('.ghost'))).toBe(true);
    expect(msgs.some((m) => m.includes('#nothing'))).toBe(true);
    expect(msgs.some((m) => m.includes('@keyframes spin'))).toBe(true);
    expect(msgs.some((m) => m.includes('"absent"'))).toBe(true);
    expect(msgs.some((m) => m.includes('missing()'))).toBe(true);
    expect(msgs.some((m) => m.includes('"open"') || m.includes('.btn') || m.includes('.box'))).toBe(false); // used classes are not flagged
  });
});

describe('Dead code, duplicates and complexity', () => {
  it('reports (and does not delete) unused code by default', async () => {
    const src = `import { a, b } from './m.js';\nexport function f(){ const dead = 1; use(a); return 2; console.log('never'); }\nfunction orphan(){}\n`;
    const r = await run({ 'f.js': src, 'm.js': 'export const a=1,b=2;' });
    const msgs = r.suggestions.filter((s) => s.kind === 'dead-code').map((s) => s.message);
    expect(msgs.some((m) => m.includes('"b"'))).toBe(true);
    expect(msgs.some((m) => m.includes('"dead"'))).toBe(true);
    expect(msgs.some((m) => m.includes('"orphan"'))).toBe(true);
    expect(msgs.some((m) => /Unreachable/.test(m))).toBe(true);
    expect(r.refined.get('f.js')!.toString()).toContain('orphan');
  });

  it('flags unreferenced files', async () => {
    const r = await run({ 'index.html': '<script src="a.js"></script>', 'a.js': 'export {}', 'lonely.js': 'export const x = 1;' });
    const hits = r.suggestions.filter((s) => s.details?.category === 'unreferenced-file').map((s) => s.file);
    expect(hits).toEqual(['lonely.js']);
  });

  it('detects structurally duplicated functions and CSS blocks', async () => {
    const fn = (name: string, v: string) => `export function ${name}(items) { const out = []; for (const i of items) { if (i.${v} > 10 && i.ok) { out.push(i.${v} * 2); } else { out.push(0); } } return out; }`;
    const r = await run({
      'a.js': fn('doubleA', 'size') + '\n' + fn('doubleB', 'weight'),
      'a.css': `.x{color:red;margin:0;padding:1px}.y{padding:1px;color:red;margin:0}`,
    });
    const dups = r.suggestions.filter((s) => s.kind === 'duplicate');
    expect(dups.some((d) => d.details?.category === 'duplicate-function')).toBe(true);
    expect(dups.some((d) => d.details?.category === 'duplicate-css')).toBe(true);
  });

  it('detects complexity: long, deep, many parameters, high branching, cycles', async () => {
    const body = Array.from({ length: 8 }, (_, i) => `if (a${i % 3} > ${i}) { x++; }`).join('\n');
    const nested = `function deep(a){ if(a){ if(a){ if(a){ if(a){ if(a){ return 1; } } } } } }`;
    const r = await run(
      { 'c.js': `function wide(a0,a1,a2,a3,a4,a5,a6){ let x = 0;\n${body}\nreturn x; }\n${nested}`, 'p.js': `import './q.js'; export const p = 1;`, 'q.js': `import './p.js'; export const q = 1;` },
      { complexity: { maxFunctionLines: 5, maxNesting: 4, maxParams: 5, maxCyclomatic: 6 } },
    );
    const msgs = r.suggestions.filter((s) => s.kind === 'complexity').map((s) => s.message);
    expect(msgs.some((m) => /wide.*parameters/.test(m))).toBe(true);
    expect(msgs.some((m) => /wide.*cyclomatic/.test(m))).toBe(true);
    expect(msgs.some((m) => /deep.*nesting/.test(m))).toBe(true);
    expect(msgs.some((m) => /Circular dependency/.test(m))).toBe(true);
  });
});

describe('Diff of results', () => {
  it('result diffs agree with the actual change', async () => {
    const r = await run({ 'a.js': `function f(a){ if (a > 1) { return true; } else { return false; } }` });
    const d = r.diffs.find((x) => x.path === 'a.js')!;
    const direct = diffText(r.original.get('a.js')!.toString(), r.refined.get('a.js')!.toString());
    expect(d.added).toBe(direct.added);
    expect(d.removed).toBe(direct.removed);
  });
});
