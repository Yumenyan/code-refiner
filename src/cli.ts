#!/usr/bin/env node
import { writeFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { DEFAULT_CONFIG, loadConfigFile, resolveConfig, ConfigError, type Config } from './core/config.js';
import { refine } from './node.js';
import { createDefaultRegistry } from './languages/index.js';
import { startUi } from './ui/server.js';
import { resolveLanguage } from './i18n/lang.js';

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
      --ai                 enable the optional AI Advisor (see --ai-provider)
      --ai-provider <p>    anthropic (default) | openai | gemini | local
                           keys come from ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY;
                           local = any OpenAI-compatible server (Ollama, LM Studio ...), no key needed
      --ai-model <name>    model name (defaults: claude-haiku-5-5 / gpt-4o-mini / gemini-2.0-flash / llama3.2)
      --ai-base-url <url>  API endpoint (local default: http://localhost:11434/v1)
      --lang <en|ja>       language of the report and messages (default: from LANG)
      --target <lang=level>  maximum language level, repeatable / comma separated:
                           javascript=es5 | rhino | es2015 ... latest   rust=2021
                           (a bare "es5" or "rhino" applies to JavaScript and TypeScript)
      --map <.ext=lang>    treat an extension as another language, e.g. --map .rhino=javascript,.gs=javascript
      --sniff              refactor files with unknown extensions by detecting their language from the content
      --threshold <name=value>  confidence thresholds (0-1): apply (renames), auto, recommend, suggest, ai
      --weight <key=value> naming score weights, e.g. --weight sourceMatch=40 (repeatable)
      --set <path=json>    set any config value, e.g. --set complexity.maxNesting=3 (repeatable)
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
  const withValue = new Set(['out', 'o', 'mode', 'm', 'config', 'c', 'port', 'ai-provider', 'ai-model', 'ai-base-url', 'lang', 'target', 'map', 'threshold', 'weight', 'set']);
  const repeatable = new Set(['target', 'map', 'threshold', 'weight', 'set']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') || (a.startsWith('-') && a.length === 2)) {
      const key = a.replace(/^-+/, '');
      if (withValue.has(key)) {
        const v = argv[++i] ?? '';
        const prev = flags.get(key);
        flags.set(key, repeatable.has(key) && typeof prev === 'string' ? `${prev}\u0000${v}` : v);
      }
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
    return flag(args, 'h', 'help') ? 0 : 1;
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
  const provider = flag(args, 'ai-provider');
  const model = flag(args, 'ai-model');
  const baseUrl = flag(args, 'ai-base-url');
  if (typeof provider === 'string' || typeof model === 'string' || typeof baseUrl === 'string') {
    overrides.aiAdvisor = true;
    overrides.ai = {
      ...base.ai,
      ...(typeof provider === 'string' ? { provider: provider as Config['ai']['provider'] } : {}),
      ...(typeof model === 'string' ? { model } : {}),
      ...(typeof baseUrl === 'string' ? { baseUrl } : {}),
    };
  }
  const langFlag = flag(args, 'lang');
  if (typeof langFlag === 'string') overrides.language = langFlag as Config['language'];
  if (flag(args, 'no-rename')) overrides.renameVariables = false;
  if (flag(args, 'remove-unused')) overrides.removeUnused = true;
  if (flag(args, 'no-validate')) overrides.validation = false;
  if (flag(args, 'run-commands')) overrides.validationOptions = { ...base.validationOptions, runCommands: true };
  const repeated = (name: string): string[] => {
    const v = flag(args, name);
    return typeof v === 'string' ? v.split('\u0000').flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean) : [];
  };
  const pair = (item: string): [string, string] => {
    const i = item.indexOf('=');
    if (i < 1) throw new ConfigError(`expected name=value, got "${item}"`);
    return [item.slice(0, i).trim(), item.slice(i + 1).trim()];
  };
  const targets: Record<string, string> = { ...base.target };
  for (const item of repeated('target')) {
    if (!item.includes('=')) {
      targets.javascript = item;
      targets.typescript = item;
    } else {
      const [k, v] = pair(item);
      targets[k] = v;
    }
  }
  if (Object.keys(targets).length) overrides.target = targets;
  const map: Record<string, string> = { ...base.languageMap };
  for (const item of repeated('map')) {
    const [k, v] = pair(item);
    map[k.startsWith('.') ? k : `.${k}`] = v;
  }
  if (Object.keys(map).length) overrides.languageMap = map;
  if (flag(args, 'sniff')) overrides.detectLanguageByContent = true;
  const thresholds = { ...base.thresholds };
  for (const item of repeated('threshold')) {
    const [k, v] = pair(item);
    const n = Number(v);
    if (!Number.isFinite(n)) throw new ConfigError(`threshold ${k}: "${v}" is not a number`);
    if (k === 'apply') overrides.renameApplyThreshold = n;
    else if (k === 'ai') overrides.aiApplyThreshold = n;
    else if (k === 'auto') thresholds.autoApply = n;
    else if (k === 'recommend' || k === 'suggest') thresholds[k] = n;
    else throw new ConfigError(`unknown threshold "${k}" (apply | auto | recommend | suggest | ai)`);
  }
  overrides.thresholds = thresholds;
  const weights = { ...base.namingWeights };
  for (const item of repeated('weight')) {
    const [k, v] = pair(item);
    if (!(k in weights)) throw new ConfigError(`unknown weight "${k}" (${Object.keys(weights).join(', ')})`);
    (weights as Record<string, number>)[k] = Number(v);
  }
  overrides.namingWeights = weights;
  let merged: Record<string, unknown> = { ...base, ...overrides } as Record<string, unknown>;
  for (const item of repeated('set')) {
    const [path, raw] = pair(item);
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      /* plain string */
    }
    const keys = path.split('.');
    merged = structuredClone(merged);
    let node = merged;
    for (const k of keys.slice(0, -1)) node = (node[k] ??= {}) as Record<string, unknown>;
    node[keys[keys.length - 1]] = value;
  }
  const config = resolveConfig(merged);

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
  if (resolveLanguage(config.language) === 'ja') {
    console.log(`\nファイル: ${s.totalFiles}   変更: ${s.changedFiles}   警告: ${s.warnings}   名前変更: ${s.renames}   ロールバック: ${s.rolledBack}`);
    console.log(`出力先: ${out}\n  refined/  original/  refined-project.zip  report.html  report.json  changes.diff`);
  } else {
    console.log(`\nFiles: ${s.totalFiles}   Changed: ${s.changedFiles}   Warnings: ${s.warnings}   Renames: ${s.renames}   Rolled back: ${s.rolledBack}`);
    console.log(`Output: ${out}\n  refined/  original/  refined-project.zip  report.html  report.json  changes.diff`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof ConfigError ? `Config error: ${e.message}` : e instanceof Error ? e.message : e);
    process.exit(1);
  },
);

