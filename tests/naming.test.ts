import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { applyAdvice, classifyConfidence, namingContextFrom, proposeNames } from '../src/naming/engine.js';
import { detectConvention, defaultConvention } from '../src/naming/convention.js';
import { VocabularyBuilder, emptyVocabulary, isAbbreviationOf } from '../src/naming/vocabulary.js';
import { pluralize, singularize, splitWords, joinWords, isPoorName } from '../src/naming/words.js';
import { parseAdvice } from '../src/ai/advisor.js';
import { AnthropicAdvisor } from '../src/ai/anthropic.js';
import type { NamingSubject } from '../src/naming/facts.js';
import { run, text } from './helpers/util.js';

const ctx = (conv = defaultConvention(), vocab = emptyVocabulary()) => namingContextFrom(DEFAULT_CONFIG, vocab, conv);
const subject = (over: Partial<NamingSubject>): NamingSubject => ({ file: 'a.js', name: 'x', kind: 'variable', valueType: 'unknown', facts: [], takenNames: new Set(), ...over });

describe('words', () => {
  it('splits and joins identifiers', () => {
    expect(splitWords('stationListData')).toEqual(['station', 'list', 'data']);
    expect(splitWords('HTTPServer_id')).toEqual(['http', 'server', 'id']);
    expect(joinWords(['active', 'station'], 'snake')).toBe('active_station');
    expect(joinWords(['active', 'station'])).toBe('activeStation');
  });
  it('inflects', () => {
    expect(pluralize('station')).toBe('stations');
    expect(pluralize('city')).toBe('cities');
    expect(pluralize('box')).toBe('boxes');
    expect(singularize('stations')).toBe('station');
    expect(singularize('cities')).toBe('city');
    expect(singularize('boxes')).toBe('box');
    expect(singularize('status')).toBe('status');
    expect(singularize('people')).toBe('person');
  });
  it('knows poor names', () => {
    for (const n of ['x', 'tmp', 'data', 'res', 'a1']) expect(isPoorName(n)).toBe(true);
    for (const n of ['stations', 'i', '_', 'activeStations']) expect(isPoorName(n)).toBe(false);
  });
});

describe('Project vocabulary', () => {
  it('collects frequent domain words and spelling variants', () => {
    const vb = new VocabularyBuilder();
    for (const id of ['station', 'stations', 'stationData', 'stationList', 'stn', 'train', 'trains', 'trainList', 'route', 'routes', 'platform', 'platform', 'platformId']) vb.add(id);
    for (let i = 0; i < 4; i++) vb.add('stnCount');
    const v = vb.build(2);
    expect(v.entries.map((e) => e.word)).toEqual(expect.arrayContaining(['station', 'train', 'route', 'platform']));
    expect(v.variantGroups.station).toEqual(expect.arrayContaining(['station', 'stations', 'stationList']));
    expect(v.abbreviations.find((a) => a.abbreviation === 'stn')?.expansion).toBe('station');
    expect(v.has('stations')).toBe(true);
    expect(v.has('banana')).toBe(false);
  });
  it('abbreviation matching', () => {
    expect(isAbbreviationOf('stn', 'station')).toBe(true);
    expect(isAbbreviationOf('btn', 'button')).toBe(true);
    expect(isAbbreviationOf('xyz', 'station')).toBe(false);
  });
});

describe('Naming convention detection', () => {
  const mk = (names: string[], type = 'array') => names.map((name) => ({ name, valueType: type }));
  it('detects xxxList', () => {
    const c = detectConvention(mk(['stationList', 'trainList', 'routeList', 'platformList']));
    expect(c.collection).toBe('suffix-List');
    expect(c.collectionStrength).toBeGreaterThan(0.9);
  });
  it('detects plural nouns', () => {
    expect(detectConvention(mk(['stations', 'trains', 'routes'])).collection).toBe('plural');
  });
  it('detects snake_case and boolean prefixes', () => {
    const c = detectConvention([...mk(['is_open', 'is_full', 'is_late'], 'boolean'), ...mk(['active_stations', 'train_list'], 'unknown')]);
    expect(c.casing).toBe('snake');
    expect(c.booleanPrefix).toBe('is');
  });
  it('reports no rule when evidence is mixed', () => {
    expect(detectConvention(mk(['stations', 'trainList', 'routeArray'])).collection).toBe('unknown');
  });
});

describe('Naming engine: candidates and scoring', () => {
  const filterFacts = [
    { type: 'source', words: ['station'], plural: true },
    { type: 'method', name: 'filter' },
    { type: 'property', name: 'active', role: 'predicate' },
  ] as NamingSubject['facts'];

  it('proposes several ranked candidates for stations.filter(s => s.active)', () => {
    const c = proposeNames(subject({ valueType: 'array', facts: filterFacts }), ctx());
    expect(c.map((x) => x.name)).toEqual(expect.arrayContaining(['activeStations', 'filteredStations', 'availableStations']));
    expect(c[0].name).toBe('activeStations');
    expect(c[0].score).toBeGreaterThan(c.find((x) => x.name === 'filteredStations')!.score);
    expect(c[0].evidence.join(' ')).toMatch(/sourceMatch/);
    expect(c[0].evidence.join(' ')).toMatch(/propertyMatch/);
  });

  it('prefers the project convention (xxxList) when it is established', () => {
    const conv = detectConvention(['stationList', 'trainList', 'routeList', 'platformList'].map((name) => ({ name, valueType: 'array' })));
    const c = proposeNames(subject({ valueType: 'array', facts: filterFacts }), ctx(conv));
    expect(c[0].name).toBe('activeStationList');
    expect(c[0].evidence.join(' ')).toMatch(/conventionMatch/);
    expect(c.map((x) => x.name)).toContain('activeStations'); // the plain plural stays available, lower
  });

  it('penalises collisions and marks the candidate unusable', () => {
    const c = proposeNames(subject({ valueType: 'array', facts: filterFacts, takenNames: new Set(['activeStations']) }), ctx());
    const hit = c.find((x) => x.name === 'activeStations')!;
    expect(hit.usable).toBe(false);
    expect(hit.rejectedReason).toMatch(/collides/);
  });

  it('penalises names that contradict the value type', () => {
    const c = proposeNames(subject({ valueType: 'string', facts: filterFacts }), ctx());
    expect(c[0].evidence.join(' ')).toMatch(/name implies array but value is string/);
  });

  it('weights are configurable', () => {
    const cfg = { ...DEFAULT_CONFIG, namingWeights: { ...DEFAULT_CONFIG.namingWeights, sourceMatch: 0 } };
    const low = proposeNames(subject({ valueType: 'array', facts: filterFacts }), namingContextFrom(cfg, emptyVocabulary(), defaultConvention()));
    const high = proposeNames(subject({ valueType: 'array', facts: filterFacts }), ctx());
    expect(low[0].score).toBe(high[0].score - 30);
  });

  it('never invents names without evidence', () => {
    expect(proposeNames(subject({ valueType: 'unknown', facts: [] }), ctx())).toEqual([]);
  });

  it('classifies confidence with configurable thresholds', () => {
    const t = DEFAULT_CONFIG.thresholds;
    expect(classifyConfidence(0.97, t)).toBe('auto');
    expect(classifyConfidence(0.85, t)).toBe('recommended');
    expect(classifyConfidence(0.6, t)).toBe('candidate');
    expect(classifyConfidence(0.3, t)).toBe('none');
    expect(classifyConfidence(0.6, { autoApply: 0.9, recommend: 0.6, suggest: 0.1 })).toBe('recommended');
  });

  it('generates DOM, collection-element and projection names', () => {
    const dom = proposeNames(subject({ valueType: 'element', facts: [{ type: 'dom', query: 'id', value: 'open-btn' }] }), ctx());
    expect(dom[0].name).toBe('openButton');
    const vb = new VocabularyBuilder();
    ['station', 'stations', 'stationList'].forEach((w) => vb.add(w));
    const el = proposeNames(
      subject({ name: 's', kind: 'parameter', valueType: 'object', facts: [{ type: 'element-of', words: ['station'], method: 'map' }, { type: 'usage', kind: 'property', property: 'id' }] }),
      ctx(defaultConvention(), vb.build(2)),
    );
    expect(el[0].name).toBe('station');
    expect(el[0].confidence).toBeGreaterThanOrEqual(0.95); // initial letter of the source is strong evidence
    const proj = proposeNames(subject({ valueType: 'array', facts: [{ type: 'source', words: ['station'], plural: true }, { type: 'method', name: 'map' }, { type: 'property', name: 'name', role: 'projection' }] }), ctx());
    expect(proj[0].name).toBe('stationNames');
  });
});

describe('AI Advisor (optional)', () => {
  const cands = () => proposeNames(subject({ valueType: 'array', facts: [{ type: 'source', words: ['station'], plural: true }, { type: 'method', name: 'filter' }] }), ctx());
  it('can veto but never invent a name', () => {
    expect(parseAdvice('{"choice":"madeUpName"}', ['a', 'b'])).toBeNull();
    expect(parseAdvice('noise {"choice":"a","rationale":"r"} noise', ['a', 'b'])).toEqual({ choice: 'a', rationale: 'r' });
    expect(parseAdvice('{"choice":null}', ['a'])).toEqual({ choice: null, rationale: undefined });
    const vetoed = applyAdvice(cands(), { choice: null }, DEFAULT_CONFIG.thresholds);
    expect(Math.max(...vetoed.map((c) => c.confidence))).toBeLessThan(DEFAULT_CONFIG.thresholds.recommend);
  });
  it('agreement adds at most +5 and cannot rescue candidates below the suggest threshold', () => {
    const base = cands();
    const top = base[0];
    const adv = applyAdvice(base, { choice: top.name }, DEFAULT_CONFIG.thresholds);
    expect(adv.find((c) => c.name === top.name)!.score).toBe(top.score + 5);
    const weak = [{ name: 'foo', score: 20, confidence: 0.2, evidence: [], usable: true }];
    expect(applyAdvice(weak, { choice: 'foo' }, DEFAULT_CONFIG.thresholds)[0].score).toBe(20);
  });
  it('talks to the Messages API with minimal context only', async () => {
    let body: { messages: { content: string }[] } | undefined;
    const fake = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"choice":"filteredStations"}' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const adv = new AnthropicAdvisor(DEFAULT_CONFIG.ai, 'k', fake);
    const res = await adv.adviseName({ file: 'a.js', kind: 'variable', currentName: 'x', valueType: 'array', candidates: [{ name: 'filteredStations', score: 60, evidence: [] }], vocabulary: ['station'] });
    expect(res?.choice).toBe('filteredStations');
    expect(body!.messages[0].content).toContain('filteredStations');
    expect(body!.messages[0].content).not.toContain('function ');
  });
  it('network failures degrade to local-only analysis', async () => {
    const adv = new AnthropicAdvisor(DEFAULT_CONFIG.ai, 'k', (async () => { throw new Error('offline'); }) as unknown as typeof fetch);
    expect(await adv.adviseName({ file: 'a', kind: 'variable', currentName: 'x', valueType: 'array', candidates: [], vocabulary: [] })).toBeNull();
  });
});

describe('Renaming in real code', () => {
  const base = { mode: 'cautious' as const, renameVariables: true };
  const src = (body: string) => `export function run(stations) {\n${body}\n}\n`;

  it('renames locals and callback params, updating every reference', async () => {
    const r = await run({ 'a.js': src(`  const x = stations.filter(s => s.active);\n  return x.length + x.map(s => s.id).length;`) }, base);
    const code = text(r, 'a.js');
    expect(code).toContain('const activeStations = stations.filter((station) => station.active)');
    expect(code).toContain('activeStations.length');
    expect(code).not.toMatch(/\bx\b/);
  });

  it('does not rename when confidence is below the apply threshold (SAFE needs 95%)', async () => {
    const r = await run({ 'a.js': src(`  const x = stations.filter(s => s.active);\n  return x.length;`) }, { ...base, mode: 'safe' });
    const code = text(r, 'a.js');
    expect(code).toContain('const x =');
    const sug = r.suggestions.find((s) => s.kind === 'rename' && s.details?.applied === false);
    expect(sug?.candidates?.[0].name).toBe('activeStations');
  });

  it('changes nothing in SAFE mode below 95% but reports candidates, and the file stays semantically identical', async () => {
    const r = await run({ 'a.js': src(`  const x = stations.filter(s => s.active);\n  return x.length;`) }, { ...base, mode: 'safe' });
    expect(r.changes.filter((c) => c.kind === 'rename' && c.before === 'x')).toHaveLength(0);
  });

  it('honours a custom apply threshold', async () => {
    const r = await run({ 'a.js': src(`  const x = stations.filter(s => s.active);\n  return x.length;`) }, { ...base, mode: 'safe', renameApplyThreshold: 0.5 });
    expect(text(r, 'a.js')).toContain('activeStations');
  });

  it('never renames exported bindings, classic-script globals or HTML-referenced names', async () => {
    const r = await run(
      {
        'mod.js': `export const x = stations.filter(s => s.active);\nexport { y };\nconst y = stations.map(s => s.name);`,
        'script.js': `var x = stations.filter(s => s.active);\nfunction go(){ return x; }`,
        'index.html': `<button onclick="t()">go</button><script src="script.js"></script>`,
      },
      base,
    );
    expect(text(r, 'mod.js')).toContain('export const x');
    expect(text(r, 'mod.js')).toMatch(/const y\b/);
    expect(text(r, 'script.js')).toMatch(/var x\b/);
  });

  it('avoids collisions with variables in nested scopes and with globals', async () => {
    const r = await run({ 'a.js': `export function f(stations) {\n  const x = stations.filter(s => s.active);\n  return x.map(() => { const activeStations = 1; return activeStations + x.length; });\n}\nexport function g(stations){ const t = stations.filter(s => s.active); return t.concat(activeStations); }` }, base);
    const code = text(r, 'a.js');
    expect(code).not.toContain('const activeStations = stations');
    expect(code).toMatch(/const (filteredStations|availableStations|matchingStations|x) =/);
    expect(code).toContain('concat(activeStations)'); // the global reference is untouched
  });

  it('skips files that use eval or with', async () => {
    const r = await run({ 'a.js': `export function f(stations){ const x = stations.filter(s => s.active); eval('x'); return x; }` }, base);
    expect(text(r, 'a.js')).toContain('const x =');
  });

  it('applies the established project convention to new names', async () => {
    const files = {
      'a.js': `export function a(stations){ const x = stations.filter(s => s.active); return x.length; }`,
      'b.js': `export const trainList = []; export const routeList = []; export const platformList = []; export const seatList = [];\nexport const stationList = [];`,
    };
    const r = await run(files, { ...base, renameApplyThreshold: 0.8 });
    expect(text(r, 'a.js')).toContain('activeStationList');
  });

  it('expands abbreviations that the project itself spells out elsewhere', async () => {
    const files = {
      'a.js': `export function f(){ const stnCount = 1; return stnCount + stnCount; }`,
      'b.js': `export const station = 1; export function stationInfo(station) { return station; }\nexport const stations = [], stationName = 'a', stationId = 1;`,
    };
    const r = await run(files, { ...base, renameApplyThreshold: 0.6 });
    expect(r.analysis.abbreviations.find((a) => a.abbreviation === 'stn')?.expansion).toBe('station');
    expect(text(r, 'a.js')).toContain('stationCount');
  });
});
