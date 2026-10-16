import { createAdvisor } from './ai/anthropic.js';
import type { AIAdvisor } from './ai/advisor.js';
import { analyzeComplexity } from './analysis/complexity.js';
import { analyzeCrossReferences, type CrossRefModel } from './analysis/crossref.js';
import { analyzeDeadCode } from './analysis/deadcode.js';
import { detectDuplicates } from './analysis/duplicates.js';
import { resolveConfig, type Config } from './core/config.js';
import { diffFile, type FileDiff } from './core/diff.js';
import { detectMetadata } from './core/metadata.js';
import { copyableFiles, decodeText, encodeText } from './core/scanner.js';
import type { Change, Project, ProjectFile, ProjectMetadata, Suggestion, Warning } from './core/types.js';
import { createRegistry, type LanguageRegistry, type LanguagePack } from './languages/index.js';
import type { ProjectContext, RefineOutput } from './languages/types.js';
import { classifyConfidence, namingContextFrom } from './naming/engine.js';
import { detectConvention, type NamingConvention } from './naming/convention.js';
import { VocabularyBuilder, type Vocabulary } from './naming/vocabulary.js';
import type { FileModels } from './semantic/model.js';
import { buildProjectModel, type ProjectModel } from './semantic/project.js';
import { runCommandChecks, type CommandCheck, type CommandRunner } from './validation/commands.js';
import { disabledReport, validateFiles, type FileState, type ValidationReport } from './validation/validator.js';

export type FileStatus = 'changed' | 'unchanged' | 'ignored' | 'omitted' | 'binary' | 'unsupported' | 'rolled-back' | 'skipped';

export interface FileResult {
  path: string;
  status: FileStatus;
  language?: string;
  changes: number;
  note?: string;
}

export interface RefineStats {
  totalFiles: number;
  processedFiles: number;
  changedFiles: number;
  ignoredFiles: number;
  omittedFiles: number;
  warnings: number;
  renames: number;
  refactorings: number;
  rolledBack: number;
  linesAdded: number;
  linesRemoved: number;
}

export interface RefineResult {
  project: { name: string; source: Project['source'] };
  config: Config;
  metadata: ProjectMetadata;
  files: FileResult[];
  changes: Change[];
  suggestions: Suggestion[];
  warnings: Warning[];
  analysis: {
    vocabulary: { word: string; count: number; variants: string[] }[];
    variantGroups: Record<string, string[]>;
    abbreviations: Vocabulary['abbreviations'];
    convention: NamingConvention;
    crossRef: CrossRefModel;
    dependencies: ProjectModel['dependencies'];
    cycles: string[][];
    callGraph: { caller: string; callee: string }[];
    functions: { id: string; name: string; file: string; line: number; params: string[]; returnsValue: boolean; exported: boolean; calls: string[]; calledBy: string[] }[];
    variables: { name: string; file: string; line: number; kind: string; type?: string; scope: string; init?: string; sources: string[]; references: number; assignments: number; exported: boolean }[];
    modules: { file: string; imports: { source: string; resolved?: string; names: string[] }[]; exports: string[] }[];
    dataFlow: { from: string; to: string; via: string; file: string }[];
  };
  validation: ValidationReport & { commands: CommandCheck[] };
  diffs: FileDiff[];
  stats: RefineStats;
  confidence: { auto: number; recommended: number; candidate: number };
  /** Everything that would be written to `refined/` (path -> bytes). */
  refined: Map<string, Buffer>;
  /** The untouched input (path -> bytes). */
  original: Map<string, Buffer>;
  aiUsed: boolean;
}

export interface RefineOptions {
  registry?: LanguageRegistry;
  advisor?: AIAdvisor;
  /** Use locally installed native formatters. Defaults to true under Node. */
  native?: boolean;
  env?: NodeJS.ProcessEnv;
  commandRunner?: CommandRunner;
  /** Directory whose node_modules may be linked into validation sandboxes. */
  nodeModulesDir?: string;
  log?: (message: string) => void;
}

const decoder = (f: ProjectFile) => decodeText(f);

/** Keeps a file's dominant line ending: tools downstream (recast, Prettier) may normalise it. */
export function matchLineEndings(original: string, code: string): string {
  const crlf = (original.match(/\r\n/g) ?? []).length;
  const lf = (original.match(/(?<!\r)\n/g) ?? []).length;
  const wantCrlf = crlf > lf;
  return wantCrlf ? code.replace(/\r?\n/g, '\r\n') : crlf === 0 ? code : code.replace(/\r\n/g, '\n');
}

function prettierOverrides(project: Project): Record<string, unknown> {
  for (const f of project.files) {
    if (f.omitted || !f.data) continue;
    if (['.prettierrc', '.prettierrc.json'].includes(f.path)) {
      try {
        return JSON.parse(f.data.toString('utf8')) as Record<string, unknown>;
      } catch {
        /* fall through */
      }
    }
  }
  const pkg = project.files.find((f) => f.path === 'package.json' && f.data);
  if (pkg) {
    try {
      const p = JSON.parse(pkg.data!.toString('utf8')) as { prettier?: Record<string, unknown> };
      if (p.prettier && typeof p.prettier === 'object') return p.prettier;
    } catch {
      /* ignore */
    }
  }
  return {};
}

async function loadExternalPacks(registry: LanguageRegistry, specs: string[], warnings: Warning[]): Promise<void> {
  for (const spec of specs) {
    try {
      const target = spec.startsWith('.') || spec.startsWith('/') ? (await import('node:url')).pathToFileURL((await import('node:path')).resolve(spec)).href : spec;
      const mod = (await import(target)) as { default?: LanguagePack | LanguagePack[]; languagePacks?: LanguagePack[] };
      const packs = mod.languagePacks ?? (Array.isArray(mod.default) ? mod.default : mod.default ? [mod.default] : []);
      if (!packs.length) throw new Error('module exports no Language Pack');
      for (const p of packs) registry.register(p);
    } catch (e) {
      warnings.push({ code: 'language-pack', message: `Could not load Language Pack "${spec}": ${(e as Error).message}` });
    }
  }
}

/** Refines an already scanned project. Pure with respect to the file system (except opt-in command validation). */
export async function refineProject(project: Project, configInput: Partial<Config> | Config = {}, options: RefineOptions = {}): Promise<RefineResult> {
  const config = resolveConfig(configInput);
  const log = options.log ?? (() => undefined);
  const warnings: Warning[] = [];
  const registry = options.registry ?? (await createRegistry({ prettier: prettierOverrides(project) as never, native: options.native }));
  await loadExternalPacks(registry, config.languagePacks, warnings);

  const ai = options.advisor ? { advisor: options.advisor } : createAdvisor(config, options.env);
  if ('warning' in ai && ai.warning) warnings.push({ code: 'ai-unavailable', message: ai.warning });
  const advisor = ai.advisor;

  // ---- Phase 1: inventory ------------------------------------------------------------------
  const texts = new Map<string, string>();
  const boms = new Map<string, boolean>();
  const analyzable: ProjectFile[] = [];
  for (const f of project.files) {
    if (f.omitted || !f.data || f.ignored || f.kind === 'binary') continue;
    const pack = registry.forFile(f.path);
    const { text, bom } = decoder(f);
    texts.set(f.path, text);
    boms.set(f.path, bom);
    if (pack) analyzable.push(f);
  }
  const textOf = (p: string) => texts.get(p) ?? (() => {
    const f = project.files.find((x) => x.path === p && x.data);
    return f ? f.data!.toString('utf8') : undefined;
  })();
  const metadata = detectMetadata(project, textOf, registry.supportedLanguageIds());
  log(`Detected ${metadata.runtime} project: ${metadata.languages.join(', ') || 'no code'}`);

  // ---- Phase 2/3: parse + semantic analysis --------------------------------------------------
  const models = new Map<string, FileModels>();
  for (const pack of new Set(analyzable.map((f) => registry.forFile(f.path)!))) {
    try {
      await pack.init?.();
    } catch (e) {
      warnings.push({ code: 'pack-init', message: `${pack.displayName}: ${(e as Error).message}` });
    }
  }
  for (const f of analyzable) {
    const pack = registry.forFile(f.path)!;
    try {
      const m = pack.analyze?.({ file: f.path, source: texts.get(f.path)! });
      if (m && Object.keys(m).length) models.set(f.path, m);
    } catch (e) {
      warnings.push({ code: 'analysis-failed', file: f.path, message: (e as Error).message });
    }
  }
  const pathSet = new Set(project.files.filter((f) => !f.omitted).map((f) => f.path));
  const model = buildProjectModel(models, pathSet);
  const crossRef = analyzeCrossReferences(models);

  // Entry points discovered from HTML <script src>.
  const entrySet = new Set(metadata.entryPoints);
  for (const d of model.dependencies) if (d.kind === 'script') entrySet.add(d.to);
  metadata.entryPoints = [...entrySet].sort();

  // ---- Phase 5: vocabulary + naming convention -----------------------------------------------
  const vb = new VocabularyBuilder();
  const samples: { name: string; valueType?: string }[] = [];
  for (const [, m] of models) {
    if (m.semantic) {
      for (const [id, n] of Object.entries(m.semantic.identifierCounts)) vb.add(id, Math.min(n, 10));
      for (const v of m.semantic.variables) if (v.kind !== 'import' && v.kind !== 'function' && v.kind !== 'class') samples.push({ name: v.name, valueType: v.valueType });
    }
    if (m.html) for (const el of m.html.elements) { if (el.id) vb.add(el.id); el.classes.forEach((c) => vb.add(c)); }
    if (m.css) for (const s of m.css.selectors) { s.classes.forEach((c) => vb.add(c)); s.ids.forEach((c) => vb.add(c)); }
  }
  const vocabulary = vb.build(2);
  const convention = detectConvention(samples.filter((s) => s.name.length > 2));
  const naming = namingContextFrom(config, vocabulary, convention);

  const project_: ProjectContext = {
    naming,
    protectedNames: new Set(crossRef.protectedNames),
    advisor,
  };
  project_.refineEmbedded = async (language, source, opts) => {
    const pack = registry.get(language);
    if (!pack) return { code: source, changes: [], suggestions: [], warnings: [] };
    return pack.refine({ file: opts.file, source, config, project: project_, embedded: opts });
  };

  // ---- Phase 4/6: refine every file ------------------------------------------------------------
  const changes: Change[] = [];
  const suggestions: Suggestion[] = [];
  const fileResults = new Map<string, FileResult>();
  const states: FileState[] = [];
  const outputs = new Map<string, RefineOutput>();

  for (const f of project.files) {
    if (f.omitted) {
      fileResults.set(f.path, { path: f.path, status: 'omitted', changes: 0, note: f.ignoreReason });
      continue;
    }
    if (f.ignored) {
      fileResults.set(f.path, { path: f.path, status: 'ignored', changes: 0, note: f.ignoreReason });
      continue;
    }
    if (f.kind === 'binary') {
      fileResults.set(f.path, { path: f.path, status: 'binary', changes: 0 });
      continue;
    }
    const pack = registry.forFile(f.path);
    if (!pack) {
      fileResults.set(f.path, { path: f.path, status: 'unsupported', language: f.language, changes: 0, note: f.language ? `no Language Pack for ${f.language}` : undefined });
      continue;
    }
    const source = texts.get(f.path)!;
    let out: RefineOutput;
    try {
      out = await pack.refine({ file: f.path, source, config, project: project_ });
      out.code = matchLineEndings(source, out.code);
    } catch (e) {
      warnings.push({ code: 'refine-failed', file: f.path, message: (e as Error).message });
      out = { code: source, changes: [], suggestions: [], warnings: [] };
    }
    outputs.set(f.path, out);
    changes.push(...out.changes);
    suggestions.push(...out.suggestions);
    warnings.push(...out.warnings);
    states.push({
      path: f.path,
      language: pack.id,
      original: source,
      refined: out.code,
      semanticRules: [...new Set(out.changes.filter((c) => c.kind !== 'format').map((c) => c.ruleId))],
    });
    log(`${out.code === source ? 'ok     ' : 'changed'} ${f.path}`);
  }

  // ---- Phase 7: validation + rollback -------------------------------------------------------
  let validation: ValidationReport & { commands: CommandCheck[] };
  if (config.validation) {
    const base = await validateFiles(states, registry, config);
    validation = { ...base, commands: [] };
    warnings.push(...base.warnings);
  } else {
    validation = { ...disabledReport(), commands: [] };
  }

  if (config.validation && config.validationOptions.runCommands && metadata.validationCommands.length) {
    const toFiles = (useRefined: boolean) =>
      project.files
        .filter((f) => !f.omitted && f.data)
        .map((f) => {
          const st = useRefined ? states.find((s) => s.path === f.path) : undefined;
          return { path: f.path, data: st ? encodeText(st.refined, boms.get(f.path) ?? false) : f.data! };
        });
    const checks = await runCommandChecks(metadata.validationCommands, toFiles(false), toFiles(true), {
      timeoutMs: config.validationOptions.commandTimeoutMs,
      nodeModules: options.nodeModulesDir,
      runner: options.commandRunner,
    });
    validation.commands = checks;
    for (const c of checks) {
      validation.checks.push({ name: `command: ${c.command.command}`, status: c.verdict === 'skipped' ? 'skipped' : c.verdict, detail: c.note });
    }
    if (checks.some((c) => c.verdict === 'failed')) {
      for (const s of states) {
        if (s.refined !== s.original) {
          s.refined = s.original;
          validation.rolledBack.push(s.path);
        }
      }
      warnings.push({ code: 'rolled-back', message: 'A build/test command passed on the original but failed on the refined project. Every change was reverted.' });
    }
  } else if (config.validation && metadata.validationCommands.length) {
    validation.checks.push({ name: 'build/test', status: 'skipped', detail: `commands found (${metadata.validationCommands.map((c) => c.command).join(', ')}) but not run: enable validationOptions.runCommands to execute project scripts` });
  }

  // ---- Assemble outputs -----------------------------------------------------------------------
  const original = new Map<string, Buffer>();
  const refined = new Map<string, Buffer>();
  for (const f of copyableFiles(project.files)) original.set(f.path, f.data);
  for (const f of copyableFiles(project.files)) refined.set(f.path, f.data);
  const rolled = new Set(validation.rolledBack);
  for (const s of states) {
    if (s.refined !== s.original) refined.set(s.path, encodeText(s.refined, boms.get(s.path) ?? false));
    const out = outputs.get(s.path)!;
    const kept = s.refined !== s.original;
    fileResults.set(s.path, {
      path: s.path,
      status: rolled.has(s.path) ? 'rolled-back' : kept ? 'changed' : 'unchanged',
      language: s.language,
      changes: rolled.has(s.path) ? 0 : out.changes.length,
    });
  }
  // Drop changes and applied suggestions of rolled back files.
  const finalChanges = changes.filter((c) => !rolled.has(c.file));
  const finalSuggestions = suggestions.filter((s) => !(rolled.has(s.file) && s.details?.applied === true));

  // Analyses on the original code.
  const htmlHandlerNames = new Set(crossRef.protectedNames);
  const analysisSuggestions: Suggestion[] = [
    ...analyzeDeadCode(model, texts, project.files, metadata, htmlHandlerNames),
    ...detectDuplicates(models, texts),
    ...analyzeComplexity(model, config.complexity),
    ...crossRef.suggestions,
  ];

  const diffs: FileDiff[] = [];
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const s of states) {
    const d = diffFile(s.path, s.original, s.refined);
    if (d.status !== 'unchanged') {
      diffs.push(d);
      linesAdded += d.added;
      linesRemoved += d.removed;
    }
  }

  const allSuggestions = [...finalSuggestions, ...analysisSuggestions];
  const confidence = { auto: 0, recommended: 0, candidate: 0 };
  for (const s of allSuggestions) {
    if (s.kind !== 'rename' || s.confidence === undefined) continue;
    const cls = classifyConfidence(s.confidence, config.thresholds);
    if (cls === 'auto') confidence.auto++;
    else if (cls === 'recommended') confidence.recommended++;
    else if (cls === 'candidate') confidence.candidate++;
  }

  const files = [...fileResults.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  const stats: RefineStats = {
    totalFiles: project.files.filter((f) => !f.path.endsWith('/')).length,
    processedFiles: states.length,
    changedFiles: files.filter((f) => f.status === 'changed').length,
    ignoredFiles: files.filter((f) => f.status === 'ignored').length,
    omittedFiles: files.filter((f) => f.status === 'omitted').length,
    warnings: warnings.length,
    renames: finalChanges.filter((c) => c.kind === 'rename').length,
    refactorings: finalChanges.filter((c) => c.kind === 'refactor' || c.kind === 'markup' || c.kind === 'style').length,
    rolledBack: rolled.size,
    linesAdded,
    linesRemoved,
  };

  return {
    project: { name: project.name, source: project.source },
    config,
    metadata,
    files,
    changes: finalChanges,
    suggestions: allSuggestions,
    warnings,
    analysis: {
      vocabulary: vocabulary.entries.slice(0, 60).map((e) => ({ word: e.word, count: e.count, variants: e.variants.slice(0, 8) })),
      variantGroups: vocabulary.variantGroups,
      abbreviations: vocabulary.abbreviations,
      convention,
      crossRef,
      dependencies: model.dependencies,
      cycles: model.cycles,
      callGraph: model.callGraph.filter((c) => !c.callee.startsWith('?') && !c.callee.startsWith('import:')).map((c) => ({ caller: c.caller, callee: c.callee })),
      functions: model.functions.map((f) => ({
        id: f.id,
        name: f.name,
        file: f.file,
        line: f.loc.line,
        params: f.params,
        returnsValue: f.returnsValue,
        exported: f.exported,
        calls: f.calls,
        calledBy: [...new Set(model.callGraph.filter((c) => c.callee === f.id).map((c) => c.caller))],
      })),
      variables: [...models.values()]
        .flatMap((m) => m.semantic?.variables ?? [])
        .slice(0, 5000)
        .map((v) => ({ name: v.name, file: v.file, line: v.loc.line, kind: v.kind, type: v.valueType, scope: v.scopeKind, init: v.init, sources: v.sources.map((x) => x.split('::')[1]?.split('@')[0] ?? x), references: v.references.length, assignments: v.assignments, exported: v.exported })),
      modules: [...models.values()]
        .filter((m) => m.semantic)
        .map((m) => ({
          file: m.semantic!.file,
          imports: m.semantic!.module.imports.map((i) => ({ source: i.source, resolved: i.resolved, names: i.specifiers.map((x) => x.local) })),
          exports: m.semantic!.module.exports.map((e) => e.name),
        })),
      dataFlow: model.dataFlow.filter((d) => !d.to.includes('#')).map((d) => ({ from: d.from, to: d.to, via: d.via, file: d.file })),
    },
    validation,
    diffs,
    stats,
    confidence,
    refined,
    original,
    aiUsed: !!advisor,
  };
}
