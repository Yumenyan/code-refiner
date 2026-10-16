import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../src/languages/index.js';
import type { LanguagePack } from '../src/languages/types.js';
import type { CommandRunner } from '../src/validation/commands.js';
import { typecheckProject, regressions } from '../src/validation/typecheck.js';
import { memProject } from './helpers/util.js';
import { refineProject } from '../src/pipeline.js';

/** A Language Pack that misbehaves on purpose, to prove the safety net catches it. */
function evilJs(transform: (src: string) => string, kind: 'refactor' | 'format' = 'refactor'): LanguagePack {
  const base = createDefaultRegistry().get('javascript')!;
  return { ...base, refine: async (input) => ({ code: transform(input.source), changes: [{ file: input.file, kind, ruleId: kind === 'format' ? 'format' : 'evil', level: 'safe', description: 'evil', confidence: 1 }], suggestions: [], warnings: [] }) };
}
const registryWith = (pack: LanguagePack) => {
  const reg = createDefaultRegistry();
  reg.register(pack);
  return reg;
};

describe('Validation + rollback', () => {
  it('rolls a file back when its output no longer parses', async () => {
    const project = memProject({ 'a.js': 'export const a = 1;\n', 'b.js': 'export const b = 2;\n' });
    const r = await refineProject(project, {}, { registry: registryWith(evilJs((s) => s + '\nfunction (( {')) });
    expect(r.refined.get('a.js')!.toString()).toBe('export const a = 1;\n');
    expect(r.validation.rolledBack.sort()).toEqual(['a.js', 'b.js']);
    expect(r.files.every((f) => f.status === 'rolled-back')).toBe(true);
    expect(r.changes).toHaveLength(0);
    expect(r.warnings.some((w) => w.code === 'rolled-back')).toBe(true);
  });

  it('rolls a file back when exported names change', async () => {
    const project = memProject({ 'a.js': 'export const a = 1;\nexport const b = 2;\n' });
    const r = await refineProject(project, {}, { registry: registryWith(evilJs((s) => s.replace('export const b = 2;', 'const b = 2;'))) });
    expect(r.refined.get('a.js')!.toString()).toContain('export const b');
    expect(r.validation.checks.some((c) => c.name === 'surface' && c.status === 'rolled-back')).toBe(true);
  });

  it('rolls back formatting that changes meaning (equivalence proof)', async () => {
    const project = memProject({ 'a.js': 'const a = 1 + 2;\n' });
    const r = await refineProject(project, {}, { registry: registryWith(evilJs((s) => s.replace('1 + 2', '1 - 2'), 'format')) });
    expect(r.refined.get('a.js')!.toString()).toContain('1 + 2');
  });

  it('can be switched off (and then trusts the pack)', async () => {
    const project = memProject({ 'a.js': 'export const a = 1;\n' });
    const r = await refineProject(project, { validation: false }, { registry: registryWith(evilJs((s) => s + '\n}')) });
    expect(r.validation.enabled).toBe(false);
  });

  it('type-checks TypeScript projects and reverts regressions', async () => {
    const files = { 'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, target: 'ES2020' } }), 'a.ts': 'export const a: number = 1;\n' };
    const project = memProject(files);
    const bad = await refineProject(project, {}, { registry: registryWith({ ...createDefaultRegistry().get('typescript')!, refine: async (i) => ({ code: i.source.replace('= 1', "= 'one'"), changes: [{ file: i.file, kind: 'refactor', ruleId: 'evil', level: 'safe', description: 'x', confidence: 1 }], suggestions: [], warnings: [] }) }) });
    expect(bad.refined.get('a.ts')!.toString()).toContain('= 1');
    expect(bad.validation.checks.some((c) => c.name === 'typecheck' && c.status === 'rolled-back')).toBe(true);
  });

  it('does not blame the refinement for errors that already existed', () => {
    const files = new Map([['a.ts', 'export const a: number = "x";\n']]);
    const before = typecheckProject(files);
    const after = typecheckProject(new Map(files));
    expect(before.total).toBeGreaterThan(0);
    expect(regressions(before, after)).toEqual([]);
  });

  it('real refactorings of a typed project keep the type check green', async () => {
    const files = {
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, target: 'ES2020', module: 'ESNext', moduleResolution: 'Bundler' } }),
      'a.ts': `export interface S { name: string; active: boolean }\nexport function names(stations: S[]): string[] { var x = stations.filter(s => s.active); return x.map(s => s.name); }\nexport function big(n: number): boolean { if (n > 3) { return true; } else { return false; } }\n`,
    };
    const r = await refineProject(memProject(files), { mode: 'cautious' });
    expect(r.validation.rolledBack).toEqual([]);
    const tc = r.validation.checks.find((c) => c.name === 'typecheck')!;
    expect(tc.status).toBe('passed');
    expect(r.refined.get('a.ts')!.toString()).toContain('return n > 3');
  });

  it('runs build/test commands only when opted in, comparing original and refined', async () => {
    const files = { 'package.json': JSON.stringify({ scripts: { test: 'node t.js' } }), 'a.js': 'export const a = 1;\n' };
    const calls: string[] = [];
    const runner: CommandRunner = async (cmd, cwd) => {
      calls.push(`${cmd}@${cwd.endsWith('refined') ? 'refined' : 'original'}`);
      return { code: 0, output: '', timedOut: false };
    };
    const off = await refineProject(memProject(files), {}, { commandRunner: runner });
    expect(calls).toEqual([]);
    expect(off.validation.checks.some((c) => /not run/.test(c.detail ?? ''))).toBe(true);
    const on = await refineProject(memProject(files), { validationOptions: { typecheck: true, runCommands: true, commandTimeoutMs: 1000 } }, { commandRunner: runner });
    expect(calls).toEqual(['npm test@original', 'npm test@refined']);
    expect(on.validation.commands[0].verdict).toBe('passed');
  });

  it('reverts everything when a command passes on the original but fails on the refined project', async () => {
    const files = { 'package.json': JSON.stringify({ scripts: { test: 'x' } }), 'a.js': 'var a = [1,2];\nfunction f(x){ if (x > 1) { return true } else { return false } }\nexport { f, a };\n' };
    const runner: CommandRunner = async (_c, cwd) => ({ code: cwd.endsWith('refined') ? 1 : 0, output: 'boom', timedOut: false });
    const r = await refineProject(memProject(files), { mode: 'cautious', validationOptions: { typecheck: true, runCommands: true, commandTimeoutMs: 1000 } }, { commandRunner: runner });
    expect(r.refined.get('a.js')!.toString()).toBe(files['a.js']);
    expect(r.validation.commands[0].verdict).toBe('failed');
  });

  it('skips commands that already fail on the original', async () => {
    const files = { 'package.json': JSON.stringify({ scripts: { test: 'x' } }), 'a.js': 'export const a = 1;\n' };
    const runner: CommandRunner = async () => ({ code: 1, output: '', timedOut: false });
    const r = await refineProject(memProject(files), { validationOptions: { typecheck: true, runCommands: true, commandTimeoutMs: 1000 } }, { commandRunner: runner });
    expect(r.validation.commands[0].verdict).toBe('skipped');
  });
});
