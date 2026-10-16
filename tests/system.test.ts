import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { request as httpRequest } from 'node:http';
import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';
import { loadConfigFile, resolveConfig, ConfigError } from '../src/core/config.js';
import { LanguageRegistry, createDefaultRegistry } from '../src/languages/index.js';
import type { LanguagePack } from '../src/languages/types.js';
import { refine } from '../src/node.js';
import { refineProject } from '../src/pipeline.js';
import { startUi } from '../src/ui/server.js';
import { memProject, run, text } from './helpers/util.js';

const exec = promisify(execFile);
const ROOT = join(import.meta.dirname, '..');

describe('Configuration', () => {
  it('has the documented defaults and validates input', () => {
    const c = resolveConfig();
    expect(c).toMatchObject({ mode: 'safe', renameVariables: true, removeUnused: false, refactorDuplicates: false, aiAdvisor: false, validation: true });
    expect(() => resolveConfig({ mode: 'wild' as never })).toThrow(ConfigError);
    expect(() => resolveConfig({ thresholds: { autoApply: 0.5, recommend: 0.8, suggest: 0.1 } })).toThrow(ConfigError);
  });
  it('loads a JSON file and merges nested options', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cr-cfg-'));
    const f = join(dir, 'c.json');
    await writeFile(f, JSON.stringify({ mode: 'cautious', thresholds: { autoApply: 0.9, recommend: 0.7, suggest: 0.4 } }));
    const c = await loadConfigFile(f);
    expect(c.mode).toBe('cautious');
    expect(c.thresholds.autoApply).toBe(0.9);
    expect(c.namingWeights.sourceMatch).toBe(30);
    await writeFile(f, '{ nope');
    await expect(loadConfigFile(f)).rejects.toThrow(ConfigError);
  });
});

describe('Pipeline details', () => {
  it('preserves BOM and CRLF line endings', async () => {
    const src = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('function f(a){\r\n  if (a > 1) { return true; } else { return false; }\r\n}\r\n')]);
    const r = await run({ 'a.js': src });
    const out = r.refined.get('a.js')!;
    expect(out.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const body = out.subarray(3).toString();
    expect(body).toContain('\r\n');
    expect(body.replace(/\r\n/g, '')).not.toContain('\n');
    expect(body).toContain('return a > 1');
  });

  it('copies binaries, ignored files and unsupported languages byte for byte', async () => {
    const bin = Buffer.from([0, 1, 2, 3, 255, 254]);
    const r = await run({ 'img.png': bin, 'dist/out.js': 'var   a=1', 'conf.toml': '[a]\nb  =  1', 'node_modules/p/i.js': 'x' });
    expect(r.refined.get('img.png')).toEqual(bin);
    expect(text(r, 'dist/out.js')).toBe('var   a=1');
    expect(text(r, 'conf.toml')).toBe('[a]\nb  =  1');
    expect(r.refined.has('node_modules/p/i.js')).toBe(false);
    expect(r.files.find((f) => f.path === 'img.png')?.status).toBe('binary');
    expect(r.files.find((f) => f.path === 'dist/out.js')?.status).toBe('ignored');
  });

  it('writes original/, refined/, ZIP and report; ZIP round-trips', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cr-out-'));
    const input = join(dir, 'in.zip');
    const z = new AdmZip();
    z.addFile('app/a.js', Buffer.from('var   a = 1\n'));
    z.addFile('app/b.css', Buffer.from('a{color:red}'));
    z.writeZip(input);
    const out = join(dir, 'out');
    await refine(input, out, {});
    expect(await readFile(join(out, 'original/a.js'), 'utf8')).toBe('var   a = 1\n');
    expect(await readFile(join(out, 'refined/a.js'), 'utf8')).toContain('var a = 1;');
    const zip = new AdmZip(join(out, 'refined-project.zip'));
    expect(zip.getEntries().map((e) => e.entryName).sort()).toEqual(['a.js', 'b.css']);
    const html = await readFile(join(out, 'report.html'), 'utf8');
    expect(html).toContain('CodeRefiner report');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//);
    const json = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
    expect(json.stats.changedFiles).toBe(2);
  });

  it('report escapes hostile content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cr-xss-'));
    const input = join(dir, 'p');
    await mkdir(input);
    await writeFile(join(input, '<img src=x onerror=alert(1)>.js'), 'var   a = 1\n');
    await writeFile(join(input, 'b.css'), '.a{color:red}');
    await refine(input, join(dir, 'o'), {});
    const html = await readFile(join(dir, 'o/report.html'), 'utf8');
    expect(html).not.toContain('<img src=x');
  });

  it('AI Advisor without an API key degrades gracefully', async () => {
    const r = await run({ 'a.js': 'export function f(s){ const x = s.filter(i => i.on); return x.length; }' }, { aiAdvisor: true }, { env: {} });
    expect(r.aiUsed).toBe(false);
    expect(r.warnings.some((w) => w.code === 'ai-unavailable')).toBe(true);
    expect(r.stats.changedFiles).toBeGreaterThanOrEqual(0);
  });

  it('consults an injected advisor only for borderline candidates and stays in control', async () => {
    const asked: string[] = [];
    const advisor = { id: 'mock', adviseName: async (req: { currentName: string; candidates: { name: string }[] }) => { asked.push(req.currentName); return { choice: null }; } };
    const files = { 'a.js': 'export function f(stations){ const x = stations.filter(s => s.active); return x.length; }' };
    const r = await refineProject(memProject(files), { mode: 'cautious', aiAdvisor: true }, { advisor });
    expect(asked).toContain('x');
    // The advisor vetoed: the 85% candidate is capped below "recommended" and not applied.
    expect(text(r as never, 'a.js')).toContain('const x =');
  });
});

describe('Language Packs are extensible', () => {
  const upper: LanguagePack = {
    id: 'shout',
    displayName: 'Shout',
    extensions: ['.shout'],
    formatter: { id: 'upper', format: async (s) => s.toUpperCase() },
    rules: [],
    checkSyntax: () => ({ ok: true }),
    refine: async (i) => ({ code: i.source.toUpperCase(), changes: [{ file: i.file, kind: 'format', ruleId: 'format', level: 'safe', description: 'upper', confidence: 1 }], suggestions: [], warnings: [] }),
  };
  it('a pack registered at runtime is used without touching the core', async () => {
    const reg = createDefaultRegistry();
    reg.register(upper);
    const r = await refineProject(memProject({ 'x.shout': 'hello' }), {}, { registry: reg });
    expect(text(r as never, 'x.shout')).toBe('HELLO');
    expect(new LanguageRegistry().forFile('x.shout')).toBeUndefined();
  });
  it('packs can be loaded from a module listed in the configuration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cr-pack-'));
    const mod = join(dir, 'pack.mjs');
    await writeFile(mod, `export default { id: 'shout', displayName: 'S', extensions: ['.shout'], formatter: { id: 'u', format: async (s) => s.toUpperCase() }, rules: [], checkSyntax: () => ({ ok: true }), refine: async (i) => ({ code: i.source.toUpperCase(), changes: [], suggestions: [], warnings: [] }) };`);
    const r = await refineProject(memProject({ 'x.shout': 'abc' }), { languagePacks: [mod] });
    expect(text(r as never, 'x.shout')).toBe('ABC');
    const bad = await refineProject(memProject({ 'x.shout': 'abc' }), { languagePacks: [join(dir, 'missing.mjs')] });
    expect(bad.warnings.some((w) => w.code === 'language-pack')).toBe(true);
  });
  it('lists the rules of each pack with their level', () => {
    const js = createDefaultRegistry().get('javascript')!;
    const levels = new Set(js.rules.map((r) => r.level));
    expect(levels).toEqual(new Set(['safe', 'cautious', 'aggressive']));
  });
});

describe('Local web UI', () => {
  it('serves the page and refines an uploaded ZIP; rejects foreign requests', async () => {
    const out = await mkdtemp(join(tmpdir(), 'cr-ui-'));
    const ui = await startUi({ port: 0, outRoot: out });
    try {
      const page = await fetch(ui.url);
      const html = await page.text();
      expect(html).toContain('REFINE');
      expect(html).toContain('Enable AI Advisor');

      const z = new AdmZip();
      z.addFile('a.js', Buffer.from('function f(a){ if (a > 1) { return true; } else { return false; } }'));
      z.addFile('s.css', Buffer.from('a{color:red}'));
      const noHeader = await fetch(`${ui.url}api/refine?mode=safe`, { method: 'POST', body: z.toBuffer() });
      expect(noHeader.status).toBe(403);
      const badHost = await new Promise<number>((ok, fail) => {
        const u = new URL(ui.url);
        const req = httpRequest({ host: u.hostname, port: u.port, path: '/', headers: { host: 'evil.example.com' } }, (res) => { res.resume(); ok(res.statusCode ?? 0); });
        req.on('error', fail);
        req.end();
      });
      expect(badHost).toBe(403);

      const res = await fetch(`${ui.url}api/refine?mode=safe&name=demo`, { method: 'POST', headers: { 'x-coderefiner': '1' }, body: z.toBuffer() });
      const j = (await res.json()) as { id: string; files: number; changed: number; warnings: number; refinedDir: string };
      expect(res.status).toBe(200);
      expect(j).toMatchObject({ files: 2, changed: 2 });
      expect(await readFile(join(j.refinedDir, 'a.js'), 'utf8')).toContain('return a > 1');
      const report = await fetch(`${ui.url}out/${j.id}/report.html`);
      expect(report.status).toBe(200);
      expect(report.headers.get('content-security-policy')).toContain("default-src 'none'");
      const zip = await fetch(`${ui.url}out/${j.id}/refined-project.zip`);
      expect(zip.headers.get('content-type')).toBe('application/zip');
      expect((await fetch(`${ui.url}out/${j.id}/../../etc/passwd`)).status).toBe(404);
      expect((await fetch(`${ui.url}out/nope/report.html`)).status).toBe(404);
    } finally {
      await ui.close();
    }
  });
});

describe('CLI', () => {
  it('refines a folder and prints a summary (built output)', async () => {
    // The CLI test uses the TypeScript sources through tsx-less node by building first.
    await exec('npx', ['tsc', '-p', 'tsconfig.json'], { cwd: ROOT });
    const dir = await mkdtemp(join(tmpdir(), 'cr-cli-'));
    const input = join(dir, 'proj');
    await mkdir(input);
    await writeFile(join(input, 'a.js'), 'function f(){ var   a=[1]; return a.length }\n');
    const { stdout } = await exec('node', [join(ROOT, 'dist/cli.js'), input, '--mode', 'cautious', '-q'], { cwd: dir });
    expect(stdout).toMatch(/Files: 1\s+Changed: 1/);
    expect(await readFile(join(dir, 'proj-refined/refined/a.js'), 'utf8')).toContain('const a = [1];');
    expect(await readFile(join(input, 'a.js'), 'utf8')).toBe('function f(){ var   a=[1]; return a.length }\n');
    const rules = await exec('node', [join(ROOT, 'dist/cli.js'), 'rules']);
    expect(rules.stdout).toContain('if-return-boolean');
    await expect(exec('node', [join(ROOT, 'dist/cli.js'), join(dir, 'nope')])).rejects.toBeTruthy();
    await expect(exec('node', [join(ROOT, 'dist/cli.js'), input, '-o', join(input, 'out')])).rejects.toBeTruthy();
  }, 60_000);
});
