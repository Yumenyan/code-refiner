import { cp, mkdtemp, readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { refine } from '../src/pipeline.js';
import { createDefaultRegistry } from '../src/languages/index.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/golden-project');
const EXPECTED = join(FIXTURE, 'expected');

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === 'expected') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(p, base)));
    else out.push(p.slice(base.length + 1));
  }
  return out.sort();
}

async function refineFixture(mode: 'safe' | 'cautious') {
  const out = await mkdtemp(join(tmpdir(), 'cr-golden-'));
  const input = await mkdtemp(join(tmpdir(), 'cr-input-'));
  await cp(FIXTURE, input, { recursive: true, filter: (s) => !s.includes('/expected') });
  const result = await refine(input, out, { mode });
  return { out, input, result };
}

/** Executes messy.js against a tiny fake DOM and records what it logs / renders. */
function behaviour(js: string): unknown {
  const log: unknown[] = [];
  const handlers: Record<string, () => void> = {};
  const elements: Record<string, { innerHTML: string; addEventListener(e: string, h: () => void): void }> = {};
  const el = (id: string) => (elements[id] ??= { innerHTML: '', addEventListener: (e, h) => (handlers[`${id}:${e}`] = h) });
  const ctx = vm.createContext({ document: { getElementById: el }, console: { log: (...a: unknown[]) => log.push(a) } });
  vm.runInContext(js + '\n;this.__exports = { openStation, render, totalPassengers, isBusy };', ctx);
  handlers['open-btn:click']();
  const api = (ctx as unknown as { __exports: Record<string, (...a: unknown[]) => unknown> }).__exports;
  return { log, html: elements['station-list'].innerHTML, busy: [api.isBusy(50), api.isBusy(150)], total: api.totalPassengers() };
}

describe('Golden project', () => {
  it('matches the expected output (cautious mode)', async () => {
    const { out } = await refineFixture('cautious');
    const refined = join(out, 'refined');
    const files = await listFiles(refined);
    if (process.env.UPDATE_GOLDEN) {
      for (const f of files) {
        await mkdir(dirname(join(EXPECTED, f)), { recursive: true });
        await writeFile(join(EXPECTED, f), await readFile(join(refined, f)));
      }
    }
    expect(files).toEqual(await listFiles(EXPECTED, EXPECTED));
    for (const f of files) expect(await readFile(join(refined, f), 'utf8'), f).toBe(await readFile(join(EXPECTED, f), 'utf8'));
  });

  it('keeps the original project untouched and writes it next to the result', async () => {
    const { out, input } = await refineFixture('cautious');
    for (const f of await listFiles(input)) {
      const original = await readFile(join(input, f));
      expect(await readFile(join(out, 'original', f))).toEqual(original);
      expect((await stat(join(input, f))).isFile()).toBe(true);
    }
    for (const f of ['report.html', 'report.json', 'refined-project.zip', 'changes.diff']) expect((await stat(join(out, f))).size).toBeGreaterThan(0);
  });

  it('output parses again in every language', async () => {
    const { out } = await refineFixture('cautious');
    const reg = createDefaultRegistry();
    for (const f of await listFiles(join(out, 'refined'))) {
      const pack = reg.forFile(f);
      if (!pack) continue;
      const res = await pack.checkSyntax(await readFile(join(out, 'refined', f), 'utf8'), f);
      expect(res.ok, f).toBe(true);
    }
  });

  it('does not change behaviour (original vs refined JavaScript run in a sandbox)', async () => {
    const { out } = await refineFixture('cautious');
    const before = behaviour(await readFile(join(out, 'original/messy.js'), 'utf8'));
    const after = behaviour(await readFile(join(out, 'refined/messy.js'), 'utf8'));
    expect(after).toEqual(before);
    expect((before as { log: unknown[] }).log.length).toBeGreaterThan(0);
  });

  it('is stable: refining the refined output changes nothing', async () => {
    const { out } = await refineFixture('cautious');
    const out2 = await mkdtemp(join(tmpdir(), 'cr-golden2-'));
    const second = await refine(join(out, 'refined'), out2, { mode: 'cautious' });
    expect(second.stats.changedFiles).toBe(0);
    expect(second.changes).toHaveLength(0);
  });

  it('does not rename low-confidence names and never touches shared globals', async () => {
    const { out } = await refineFixture('cautious');
    const js = await readFile(join(out, 'refined/messy.js'), 'utf8');
    expect(js).toMatch(/var stn = /); // classic-script global: other files may use it
    expect(js).toMatch(/function render\(list\)/); // global function: HTML may call it
    const html = await readFile(join(out, 'refined/messy.html'), 'utf8');
    expect(html).toContain('onclick="clearAll()"');
    expect(html).toContain('id="open-btn"');
  });

  it('SAFE mode only applies >=95% renames and leaves candidates in the report', async () => {
    const { out, result } = await refineFixture('safe');
    const js = await readFile(join(out, 'refined/messy.js'), 'utf8');
    expect(js).not.toContain('activeStations');
    const cands = result.suggestions.find((s) => s.kind === 'rename' && s.details?.applied === false && s.candidates?.some((c) => c.name === 'activeStations'));
    expect(cands).toBeTruthy();
    expect(result.changes.filter((c) => c.kind === 'rename').every((c) => c.confidence >= 0.95)).toBe(true);
  });
});
