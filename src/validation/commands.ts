import { spawn } from 'node:child_process';
import { mkdtemp, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFiles } from '../core/output.js';
import type { ValidationCommand } from '../core/types.js';

export interface CommandOutcome {
  code: number | null;
  output: string;
  timedOut: boolean;
}
export type CommandRunner = (command: string, cwd: string, timeoutMs: number) => Promise<CommandOutcome>;

/** Runs a project script in a shell. Only used when the user explicitly enables `runCommands`. */
export const shellRunner: CommandRunner = (command, cwd, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: { ...process.env, CI: '1', FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const collect = (d: Buffer) => {
      output += d.toString();
      if (output.length > 20_000) output = output.slice(-20_000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 127, output: String(e), timedOut });
    });
  });

export interface CommandCheck {
  command: ValidationCommand;
  original: CommandOutcome;
  refined?: CommandOutcome;
  verdict: 'passed' | 'failed' | 'skipped';
  note?: string;
}

/**
 * Builds/tests both versions in temp directories. A command only counts as a regression
 * when it passes on the original and fails on the refined project.
 */
export async function runCommandChecks(
  commands: ValidationCommand[],
  original: { path: string; data: Buffer }[],
  refined: { path: string; data: Buffer }[],
  opts: { timeoutMs: number; nodeModules?: string; runner?: CommandRunner },
): Promise<CommandCheck[]> {
  const runner = opts.runner ?? shellRunner;
  const results: CommandCheck[] = [];
  if (!commands.length) return results;
  const root = await mkdtemp(join(tmpdir(), 'coderefiner-validate-'));
  const dirs = { original: join(root, 'original'), refined: join(root, 'refined') };
  try {
    await writeFiles(dirs.original, original);
    await writeFiles(dirs.refined, refined);
    if (opts.nodeModules && (await stat(opts.nodeModules).catch(() => null))?.isDirectory()) {
      for (const d of Object.values(dirs)) await symlink(opts.nodeModules, join(d, 'node_modules'), 'dir').catch(() => undefined);
    }
    for (const cmd of commands) {
      const o = await runner(cmd.command, dirs.original, opts.timeoutMs);
      if (o.code !== 0) {
        results.push({ command: cmd, original: o, verdict: 'skipped', note: o.timedOut ? 'timed out on the original project' : 'fails on the original project already; cannot judge the refined one' });
        continue;
      }
      const r = await runner(cmd.command, dirs.refined, opts.timeoutMs);
      results.push({ command: cmd, original: o, refined: r, verdict: r.code === 0 ? 'passed' : 'failed', note: r.code === 0 ? undefined : r.timedOut ? 'timed out' : 'fails on the refined project but passes on the original' });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  return results;
}
