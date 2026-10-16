#!/usr/bin/env node
import { writeFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { DEFAULT_CONFIG, loadConfigFile, resolveConfig, ConfigError, type Config } from './core/config.js';
import { refine } from './pipeline.js';
import { createDefaultRegistry } from './languages/index.js';
import { startUi } from './ui/server.js';

const HELP = `CodeRefiner – restructure machine-written code into human-maintainable projects.

Usage:
  code-refiner <input.zip|folder> [options]   refine a project
  code-refiner ui [--port 4173] [--out dir]   start the local web UI
  code-refiner rules                          list refactoring rules by level
  code-refiner init-config [file]             write a default coderefiner.config.json

Options:
  -o, --out <dir>          output directory (default: <input>-refined next to the input)
  -m, --mode <level>       safe (default) | cautious | aggressive
  -c, --config <file>      JSON config file
      --ai                 enable the optional AI Advisor (needs ANTHROPIC_API_KEY)
      --no-rename          do not rename variables
      --remove-unused      remove unused imports / unreachable code / pure unused locals (cautious+)
      --no-validate        skip validation (not recommended)
      --run-commands       also run the project's build/test scripts (executes project code!)
  -q, --quiet              only print the summary
  -h, --help
`;

interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  const withValue = new Set(['out', 'o', 'mode', 'm', 'config', 'c', 'port']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') || (a.startsWith('-') && a.length === 2)) {
      const key = a.replace(/^-+/, '');
      if (withValue.has(key)) flags.set(key, argv[++i] ?? '');
      else flags.set(key, true);
    } else positional.push(a);
  }
  return { positional, flags };
}

const flag = (a: Args, ...names: string[]) => names.map((n) => a.flags.get(n)).find((v) => v !== undefined);

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const [cmd] = args.positional;
  if (!cmd || flag(args, 'h', 'help')) {
    process.stdout.write(HELP);
    return cmd ? 0 : 1;
  }

  if (cmd === 'rules') {
    for (const pack of createDefaultRegistry().list()) {
      if (!pack.rules.length) continue;
      console.log(`\n${pack.displayName}`);
      for (const r of pack.rules) console.log(`  [${r.level.padEnd(10)}] ${r.id} – ${r.description}`);
    }
    return 0;
  }
  if (cmd === 'init-config') {
    const target = args.positional[1] ?? 'coderefiner.config.json';
    const { aiAdvisor, mode, renameVariables, removeUnused, refactorDuplicates, validation } = DEFAULT_CONFIG;
    await writeFile(target, JSON.stringify({ mode, renameVariables, removeUnused, refactorDuplicates, aiAdvisor, validation }, null, 2) + '\n', { flag: 'wx' });
    console.log(`Wrote ${target}`);
    return 0;
  }

  let base: Config = DEFAULT_CONFIG;
  const configPath = flag(args, 'config', 'c');
  if (typeof configPath === 'string') base = await loadConfigFile(configPath);
  const overrides: Partial<Config> = {};
  const mode = flag(args, 'mode', 'm');
  if (typeof mode === 'string') overrides.mode = mode as Config['mode'];
  if (flag(args, 'ai')) overrides.aiAdvisor = true;
  if (flag(args, 'no-rename')) overrides.renameVariables = false;
  if (flag(args, 'remove-unused')) overrides.removeUnused = true;
  if (flag(args, 'no-validate')) overrides.validation = false;
  if (flag(args, 'run-commands')) overrides.validationOptions = { ...base.validationOptions, runCommands: true };
  const config = resolveConfig({ ...base, ...overrides });

  if (cmd === 'ui') {
    const port = Number(flag(args, 'port') ?? 4173);
    const out = typeof flag(args, 'out', 'o') === 'string' ? (flag(args, 'out', 'o') as string) : resolve('coderefiner-output');
    const ui = await startUi({ port, outRoot: out, baseConfig: config });
    console.log(`CodeRefiner UI: ${ui.url}\nResults are written to ${resolve(out)}\nPress Ctrl+C to stop.`);
    await new Promise(() => undefined);
    return 0;
  }

  const input = resolve(cmd);
  if (!(await stat(input).catch(() => null))) {
    console.error(`Input not found: ${cmd}`);
    return 2;
  }
  const outFlag = flag(args, 'out', 'o');
  const out = resolve(typeof outFlag === 'string' ? outFlag : `${input.replace(/\.zip$/i, '')}-refined`);
  if ((out + sep).startsWith(input + sep) && (await stat(input)).isDirectory()) {
    console.error('The output directory must not be inside the input folder.');
    return 2;
  }
  const quiet = !!flag(args, 'q', 'quiet');
  const result = await refine(input, out, config, { log: quiet ? undefined : (m) => console.log(m) });
  const s = result.stats;
  console.log(`\nFiles: ${s.totalFiles}   Changed: ${s.changedFiles}   Warnings: ${s.warnings}   Renames: ${s.renames}   Rolled back: ${s.rolledBack}`);
  console.log(`Output: ${out}\n  refined/  original/  refined-project.zip  report.html  report.json  changes.diff`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof ConfigError ? `Config error: ${e.message}` : e instanceof Error ? e.message : e);
    process.exit(1);
  },
);

