import type { FormatterAdapter } from '../types.js';
import { inferIndent } from '../prettier.js';

/** Runs a command with the source on stdin. Never uses a shell. Node only. */
export async function run(cmd: string, args: string[], input: string, timeoutMs = 20_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const { spawn } = await import('node:child_process');
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

export async function available(cmd: string, args: string[] = ['--version']): Promise<boolean> {
  try {
    const { spawnSync } = await import('node:child_process');
    return spawnSync(cmd, args, { input: '', stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

function clangStyle(source: string): string {
  const ind = inferIndent(source);
  const lens = source.split('\n').map((l) => l.length).sort((a, b) => a - b);
  const p95 = lens[Math.floor(lens.length * 0.95)] ?? 80;
  const limit = p95 > 110 ? 120 : p95 <= 82 ? 80 : 100;
  return `{BasedOnStyle: LLVM, SortIncludes: Never, ReflowComments: false, ColumnLimit: ${limit}, IndentWidth: ${ind?.useTabs ? 4 : ind?.tabWidth ?? 4}, UseTab: ${ind?.useTabs ? 'Always' : 'Never'}}`;
}

export function clangFormatter(assumeName: string): FormatterAdapter {
  return {
    id: 'clang-format',
    async format(source) {
      const r = await run('clang-format', [`--assume-filename=${assumeName}`, `-style=${clangStyle(source)}`], source);
      if (r.code !== 0) throw new Error(r.stderr.split('\n')[0] || 'clang-format failed');
      return r.stdout;
    },
  };
}

export const gofmtFormatter: FormatterAdapter = {
  id: 'gofmt',
  async format(source) {
    const r = await run('gofmt', [], source);
    if (r.code !== 0) throw new Error(r.stderr.split('\n')[0] || 'gofmt failed');
    return r.stdout;
  },
};

export const rustfmtFormatter: FormatterAdapter = {
  id: 'rustfmt',
  async format(source, _file, opts) {
    const edition = opts?.edition && /^20\d\d$/.test(opts.edition) ? opts.edition : '2021';
    const r = await run('rustfmt', ['--emit', 'stdout', '--edition', edition], source);
    if (r.code !== 0) throw new Error(r.stderr.split('\n')[0] || 'rustfmt failed');
    return r.stdout.replace(/^stdin:\n\n/, '');
  },
};

export function googleJavaFormatter(): FormatterAdapter {
  return {
    id: 'google-java-format',
    async format(source) {
      const r = await run('google-java-format', ['-'], source);
      if (r.code !== 0) throw new Error(r.stderr.split('\n')[0] || 'google-java-format failed');
      return r.stdout;
    },
  };
}

export const shfmtFormatter: FormatterAdapter = {
  id: 'shfmt',
  async format(source) {
    const r = await run('shfmt', [], source);
    if (r.code !== 0) throw new Error(r.stderr.split('\n')[0] || 'shfmt failed');
    return r.stdout;
  },
};

const PY_AST_CHECK = 'import ast,json,sys\na,b=json.load(sys.stdin)\nsys.exit(0 if ast.dump(ast.parse(a))==ast.dump(ast.parse(b)) else 3)';

/** Python formatters can add commas / change quotes; accept only output with an identical AST. */
export function pythonFormatter(base: FormatterAdapter): FormatterAdapter {
  return {
    id: base.id,
    async format(source, file) {
      const out = await base.format(source, file);
      if (out === source) return out;
      const r = await run('python3', ['-I', '-c', PY_AST_CHECK], JSON.stringify([source, out]));
      if (r.code !== 0) throw new Error('formatted Python differs from the original AST');
      return out;
    },
  };
}

export const ruffFormatter: FormatterAdapter = {
  id: 'ruff',
  async format(source) {
    const r = await run('ruff', ['format', '--stdin-filename', 'x.py', '-'], source);
    if (r.code !== 0) throw new Error(r.stderr.split('\n')[0] || 'ruff failed');
    return r.stdout;
  },
};

export const blackFormatter: FormatterAdapter = {
  id: 'black',
  async format(source) {
    const r = await run('black', ['-q', '-'], source);
    if (r.code !== 0) throw new Error(r.stderr.split('\n')[0] || 'black failed');
    return r.stdout;
  },
};
