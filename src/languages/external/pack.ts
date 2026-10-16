import { spawn, spawnSync } from 'node:child_process';
import type { FormatterAdapter, LanguagePack } from '../types.js';

/** Runs a command with the source on stdin. Never uses a shell. */
function run(cmd: string, args: string[], input: string, timeoutMs = 20_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

function available(cmd: string, args: string[] = ['--version']): boolean {
  try {
    return spawnSync(cmd, args, { stdio: 'ignore', timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

function externalPack(opts: {
  id: string;
  displayName: string;
  extensions: string[];
  formatter: FormatterAdapter;
  syntax?: (source: string) => Promise<{ ok: boolean; error?: string }>;
}): LanguagePack {
  return {
    id: opts.id,
    displayName: opts.displayName,
    extensions: opts.extensions,
    formatter: opts.formatter,
    rules: [],
    checkSyntax: opts.syntax ?? (async (source) => {
      try {
        await opts.formatter.format(source, 'x');
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }),
    async refine(input) {
      const out = { code: input.source, changes: [], suggestions: [], warnings: [] } as Awaited<ReturnType<LanguagePack['refine']>>;
      try {
        const formatted = await opts.formatter.format(input.source, input.file);
        if (formatted !== input.source) {
          out.code = formatted;
          out.changes.push({ file: input.file, kind: 'format', ruleId: 'format', level: 'safe', description: `Formatted (${opts.formatter.id})`, confidence: 1 });
        }
      } catch (e) {
        out.warnings.push({ code: 'format-failed', file: input.file, message: (e as Error).message.split('\n')[0] });
      }
      return out;
    },
  };
}

/**
 * Language Packs for languages that are formatted by their native toolchain.
 * They are registered only when the tool is installed, so absence is never an error.
 * Only formatting is offered: no semantic rules exist for these languages yet.
 */
export function externalFormatterPacks(): LanguagePack[] {
  const packs: LanguagePack[] = [];

  if (available('rustfmt')) {
    const formatter: FormatterAdapter = {
      id: 'rustfmt',
      async format(source) {
        const r = await run('rustfmt', ['--emit', 'stdout', '--edition', '2021'], source);
        if (r.code !== 0) throw new Error(r.stderr.split('\n')[0] || 'rustfmt failed');
        // rustfmt --emit stdout prefixes the file name on some versions
        return r.stdout.replace(/^stdin:\n\n/, '');
      },
    };
    packs.push(externalPack({ id: 'rust', displayName: 'Rust (rustfmt)', extensions: ['.rs'], formatter }));
  }

  const pyFormatter = ((): FormatterAdapter | null => {
    if (available('ruff')) {
      return {
        id: 'ruff',
        async format(source, file) {
          const r = await run('ruff', ['format', '--stdin-filename', file.replace(/^\//, '') || 'x.py', '-'], source);
          if (r.code !== 0) throw new Error(r.stderr.split('\n')[0] || 'ruff failed');
          return r.stdout;
        },
      };
    }
    if (available('black')) {
      return {
        id: 'black',
        async format(source) {
          const r = await run('black', ['-q', '-'], source);
          if (r.code !== 0) throw new Error(r.stderr.split('\n')[0] || 'black failed');
          return r.stdout;
        },
      };
    }
    return null;
  })();
  if (pyFormatter && available('python3')) {
    packs.push(
      externalPack({
        id: 'python',
        displayName: 'Python',
        extensions: ['.py'],
        formatter: pyFormatter,
        // Syntax check via the interpreter's parser only (ast.parse never executes the code).
        syntax: async (source) => {
          const r = await run('python3', ['-I', '-c', 'import ast,sys; ast.parse(sys.stdin.read())'], source);
          return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr.trim().split('\n').pop() };
        },
      }),
    );
  }
  return packs;
}
