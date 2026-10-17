import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createAdvisor, LlmAdvisor } from '../src/ai/anthropic.js';
import { parseAdvice } from '../src/ai/advisor.js';
import { makeChat, resolveAi, aiDefaults } from '../src/ai/providers.js';
import { resolveConfig } from '../src/core/config.js';
import { translateMessage } from '../src/i18n/ja.js';
import { resolveLanguage } from '../src/i18n/lang.js';
import { UI_STRINGS } from '../src/ui/strings.js';
import { renderReportHtml } from '../src/report/html.js';
import { refineProject } from '../src/pipeline.js';
import { memProject, run, text } from './helpers/util.js';

const exec = promisify(execFile);
const ROOT = join(import.meta.dirname, '..');

interface Captured { url: string; headers: Record<string, string>; body: Record<string, unknown> }
function fakeFetch(reply: (c: Captured) => unknown, seen: Captured[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const c = { url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
    seen.push(c);
    return new Response(JSON.stringify(reply(c)), { status: 200 });
  }) as unknown as typeof fetch;
}
const req = { file: 'a.js', kind: 'variable' as const, currentName: 'x', valueType: 'array', candidates: [{ name: 'filteredStations', score: 60, evidence: [] }], vocabulary: ['station'] };

describe('AI providers', () => {
  it('OpenAI: chat completions with a bearer key and JSON mode', async () => {
    const seen: Captured[] = [];
    const chat = makeChat(resolveAi(resolveConfig({ ai: { provider: 'openai' } }).ai), 'sk-test', fakeFetch(() => ({ choices: [{ message: { content: '{"choice":"filteredStations"}' } }] }), seen));
    const adv = new LlmAdvisor(chat, 'openai');
    expect((await adv.adviseName(req))?.choice).toBe('filteredStations');
    expect(seen[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(seen[0].headers.authorization).toBe('Bearer sk-test');
    expect(seen[0].body.model).toBe(aiDefaults('openai').model);
    expect((seen[0].body.response_format as { type: string }).type).toBe('json_object');
    expect(JSON.stringify(seen[0].body)).not.toContain('sk-test');
  });

  it('Gemini: generateContent with the key in a header (never in the URL)', async () => {
    const seen: Captured[] = [];
    const chat = makeChat(resolveAi(resolveConfig({ ai: { provider: 'gemini', model: 'gemini-2.0-flash' } }).ai), 'g-key', fakeFetch(() => ({ candidates: [{ content: { parts: [{ text: '{"choice":null,"proposal":"activeStations"}' }] } }] }), seen));
    const res = await new LlmAdvisor(chat, 'gemini').adviseName(req);
    expect(res).toMatchObject({ choice: null, proposal: 'activeStations' });
    expect(seen[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent');
    expect(seen[0].url).not.toContain('g-key');
    expect(seen[0].headers['x-goog-api-key']).toBe('g-key');
  });

  it('Local LLM: OpenAI-compatible endpoint, no key required, custom base URL', async () => {
    const seen: Captured[] = [];
    const ai = resolveAi(resolveConfig({ ai: { provider: 'local', model: 'qwen2.5-coder', baseUrl: 'http://127.0.0.1:1234/v1/' } }).ai);
    const chat = makeChat(ai, undefined, fakeFetch(() => ({ choices: [{ message: { content: '<think>hmm {}</think>{"choice":"filteredStations","rationale":"ok"}' } }] }), seen));
    const res = await new LlmAdvisor(chat, 'local').adviseName(req);
    expect(res?.choice).toBe('filteredStations');
    expect(seen[0].url).toBe('http://127.0.0.1:1234/v1/chat/completions');
    expect(seen[0].headers.authorization).toBeUndefined();
    expect(seen[0].body.model).toBe('qwen2.5-coder');
  });

  it('Anthropic still works (browser header only in the browser build)', async () => {
    const seen: Captured[] = [];
    const ai = resolveAi(resolveConfig().ai);
    await new LlmAdvisor(makeChat(ai, 'k', fakeFetch(() => ({ content: [{ type: 'text', text: '{"choice":null}' }] }), seen), { browser: true }), 'a').adviseName(req);
    expect(seen[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(seen[0].headers['x-api-key']).toBe('k');
    expect(seen[0].headers['anthropic-dangerous-direct-browser-access']).toBe('true');
  });

  it('keys come from the provider-specific environment variable; hosted providers need one, local does not', () => {
    expect(createAdvisor(resolveConfig({ aiAdvisor: true, ai: { provider: 'openai' } }), {}).warning).toMatch(/OPENAI_API_KEY/);
    expect(createAdvisor(resolveConfig({ aiAdvisor: true, ai: { provider: 'gemini' } }), { GOOGLE_API_KEY: 'x' }).advisor).toBeTruthy();
    expect(createAdvisor(resolveConfig({ aiAdvisor: true, ai: { provider: 'local' } }), {}).advisor).toBeTruthy();
    expect(createAdvisor(resolveConfig({ aiAdvisor: false }), {}).advisor).toBeUndefined();
    expect(() => resolveConfig({ ai: { provider: 'nope' as never } })).toThrow();
  });

  it('failures degrade to local-only analysis', async () => {
    const chat = makeChat(resolveAi(resolveConfig({ ai: { provider: 'openai' } }).ai), 'k', (async () => new Response('no', { status: 500 })) as unknown as typeof fetch);
    expect(await new LlmAdvisor(chat, 'o').adviseName(req)).toBeNull();
  });

  it('parseAdvice only accepts valid identifiers as proposals and known candidates as choices', () => {
    expect(parseAdvice('{"choice":"zzz","proposal":"bad name"}', ['a'])).toBeNull();
    expect(parseAdvice('{"choice":null,"proposal":"駅一覧"}', ['a'])?.proposal).toBe('駅一覧');
    expect(parseAdvice('{"choice":"a"}', ['a'])?.choice).toBe('a');
  });
});

describe('AI proposals pass through the same local safety net', () => {
  const src = 'export function f(items) { const q = items.map((i) => i.id); return q.length + q.length; }\n';
  const mock = (proposal: string | null) => ({ id: 'mock', adviseName: async () => ({ choice: null, proposal: proposal ?? undefined }) });

  it('CAUTIOUS applies a valid proposal when local analysis has nothing better', async () => {
    const r = await refineProject(memProject({ 'a.js': src }), { mode: 'cautious', aiAdvisor: true, renameVariables: true }, { advisor: mock('itemIds') });
    expect(text(r as never, 'a.js')).toContain('itemIds');
  });
  it('AI names are applied at aiApplyThreshold in every mode (SAFE included) and can be switched to report-only', async () => {
    const safeSrc = 'export function f(items) { const q = items.filter(Boolean); return q.length + q.length; }\n';
    const applied = await refineProject(memProject({ 'a.js': safeSrc }), { mode: 'safe', aiAdvisor: true }, { advisor: mock('truthyItems') });
    expect(text(applied as never, 'a.js')).toContain('truthyItems');
    const reportOnly = await refineProject(memProject({ 'a.js': safeSrc }), { mode: 'safe', aiAdvisor: true, aiApplyThreshold: 2 }, { advisor: mock('truthyItems') });
    expect(text(reportOnly as never, 'a.js')).toContain('const q');
    expect(reportOnly.suggestions.some((s) => s.candidates?.some((c) => c.name === 'truthyItems' && c.ai))).toBe(true);
  });
  it('rejects colliding, reserved or ambiguous proposals', async () => {
    for (const bad of ['items', 'class', 'data', 'not valid']) {
      const r = await refineProject(memProject({ 'a.js': src }), { mode: 'cautious', aiAdvisor: true }, { advisor: mock(bad) });
      expect(text(r as never, 'a.js'), bad).toContain('const q');
    }
  });
});

describe('Japanese (日本語)', () => {
  it('resolves the language from the setting or the environment', () => {
    expect(resolveLanguage('ja')).toBe('ja');
    expect(resolveLanguage('en', { LANG: 'ja_JP.UTF-8' })).toBe('en');
  });

  it('every UI string exists in both languages', () => {
    expect(Object.keys(UI_STRINGS.ja).sort()).toEqual(Object.keys(UI_STRINGS.en).sort());
  });

  it('translates the messages of a real run, and the report renders in Japanese', async () => {
    const files = {
      'index.html': '<button onclick="missing()">x</button><div id="a"></div><div id="a"></div><style>.unused{color:red}</style>',
      'a.js': `function f(stations){ var x = stations.filter(s => s.active); var y = 1; if (x.length) { return true; } else { return false; } }\nfunction g(a){ if(a){ if(a){ if(a){ if(a){ if(a){ return 1 } } } } } }`,
      'bad.py': 'def f(:\n',
    };
    const r = await run(files, { mode: 'aggressive', language: 'ja', removeUnused: true, complexity: { maxFunctionLines: 3, maxNesting: 3, maxParams: 5, maxCyclomatic: 3 } });
    const all = [
      ...r.changes.map((c) => c.description),
      ...r.suggestions.map((s) => s.message),
      ...r.warnings.map((w) => w.message),
      ...r.suggestions.flatMap((s) => (s.candidates ?? []).flatMap((c) => c.evidence)),
      ...r.validation.checks.flatMap((c) => [c.detail ?? '']),
    ].filter(Boolean);
    const untranslated = all.filter((m) => translateMessage(m, 'ja') === m);
    expect(untranslated).toEqual([]);
    const html = renderReportHtml(r, 'ja');
    expect(html).toContain('<html lang="ja">');
    expect(html).toContain('CodeRefiner レポート');
    expect(html).toContain('ファイルごとの変更');
    expect(html).not.toContain('>Changes by file<');
    const en = renderReportHtml(r, 'en');
    expect(en).toContain('Changes by file');
  });

  it('CLI accepts --lang ja and the AI provider flags (and degrades without a key)', async () => {
    await exec('npx', ['tsc', '-p', 'tsconfig.json'], { cwd: ROOT });
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'cr-ja-'));
    await writeFile(join(dir, 'a.js'), 'function f(){ var   a=1; return a }\n');
    const env = { ...process.env, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '' };
    const { stdout } = await exec('node', [join(ROOT, 'dist/cli.js'), dir, '--lang', 'ja', '--ai-provider', 'openai', '--ai-model', 'gpt-4o-mini', '-q'], { cwd: dir, env });
    expect(stdout).toContain('ファイル: 1');
    const { stdout: help } = await exec('node', [join(ROOT, 'dist/cli.js'), '--help']);
    expect(help).toContain('--ai-provider');
    expect(help).toContain('--lang');
  }, 60_000);
});
