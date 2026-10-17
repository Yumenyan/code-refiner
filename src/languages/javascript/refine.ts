import * as t from '@babel/types';
import { renameApplyThreshold } from '../../core/config.js';
import { SYNTAX_SINCE, ecmaLevel } from '../../core/targets.js';
import { hitToChange, rulesFor } from '../../core/rule-engine.js';
import type { Change, Suggestion, Warning } from '../../core/types.js';
import { snippet } from '../../core/text.js';
import { applyAdvice, classifyConfidence, proposeNames, withProposal } from '../../naming/engine.js';
import { splitWords } from '../../naming/words.js';
import type { FormatterAdapter, RefineInput, RefineOutput } from '../types.js';
import type { NamingAdvice } from '../../ai/advisor.js';
import { sameAst } from './ast-compare.js';
import { collectRenameTargets, conflictsWith } from './naming-adapter.js';
import { parseEcma, parseRecast, printRecast, errorMessage, type EcmaLanguage } from './parser.js';
import { ECMA_RULES, type EcmaRuleContext } from './rules.js';
import { traverse, type Scope } from './traverse.js';

/**
 * Names other code can observe: exports and (for classic scripts) top-level globals.
 * Computed straight from the top-level statements, so it is cheap enough to run after every step.
 */
export function surfaceOf(source: string, file: string, language: EcmaLanguage): string[] | undefined {
  let ast: t.File;
  try {
    ast = parseEcma(source, file, language);
  } catch {
    return undefined;
  }
  const names = new Set<string>();
  const isModule = ast.program.sourceType === 'module';
  const declared = (d: t.Node | null | undefined): string[] => {
    if (!d) return [];
    if (t.isVariableDeclaration(d)) return d.declarations.flatMap((x) => Object.keys(t.getBindingIdentifiers(x.id)));
    if ((t.isFunctionDeclaration(d) || t.isClassDeclaration(d) || t.isTSEnumDeclaration(d) || t.isTSInterfaceDeclaration(d) || t.isTSTypeAliasDeclaration(d) || t.isTSModuleDeclaration(d)) && d.id && t.isIdentifier(d.id)) return [d.id.name];
    return [];
  };
  const cjsTarget = (n: t.Node): string | null => {
    if (!t.isMemberExpression(n)) return null;
    if (t.isIdentifier(n.object, { name: 'module' }) && t.isIdentifier(n.property, { name: 'exports' })) return 'default';
    if (t.isIdentifier(n.object, { name: 'exports' }) && t.isIdentifier(n.property)) return n.property.name;
    if (t.isMemberExpression(n.object) && t.isIdentifier(n.object.object, { name: 'module' }) && t.isIdentifier(n.object.property, { name: 'exports' }) && t.isIdentifier(n.property)) return n.property.name;
    return null;
  };
  for (const stmt of ast.program.body) {
    if (t.isExportNamedDeclaration(stmt)) {
      declared(stmt.declaration).forEach((n) => names.add(`export:${n}`));
      for (const sp of stmt.specifiers) names.add(`export:${t.isExportSpecifier(sp) ? (t.isIdentifier(sp.exported) ? sp.exported.name : sp.exported.value) : t.isExportNamespaceSpecifier(sp) ? sp.exported.name : 'default'}`);
    } else if (t.isExportDefaultDeclaration(stmt)) names.add('export:default');
    else if (t.isExportAllDeclaration(stmt)) names.add('export:*');
    else if (t.isExpressionStatement(stmt) && t.isAssignmentExpression(stmt.expression)) {
      const target = cjsTarget(stmt.expression.left);
      if (target) names.add(`export:${target}`);
    }
    if (!isModule) declared(stmt).forEach((n) => names.add(`global:${n}`));
  }
  return [...names].sort();
}

const ES3_RESERVED = new Set(['abstract', 'boolean', 'byte', 'char', 'double', 'final', 'float', 'goto', 'int', 'long', 'native', 'short', 'synchronized', 'throws', 'transient', 'volatile']);

/** Reports syntax newer than the configured target; such code is left as it is. */
function warnNewSyntax(ast: t.File, ecma: number, label: string, warn: (code: string, message: string) => void): void {
  const seen = new Map<string, { since: number; line: number }>();
  traverse(ast, {
    enter(p) {
      let hit = SYNTAX_SINCE[p.node.type];
      const n = p.node as t.Node;
      if (t.isVariableDeclaration(n) && n.kind !== 'var') hit = [2015, n.kind];
      else if (t.isLogicalExpression(n, { operator: '??' })) hit = [2020, '?? operator'];
      else if (t.isBinaryExpression(n, { operator: '**' })) hit = [2016, '** operator'];
      else if (t.isObjectProperty(n) && n.shorthand) hit = [2015, 'shorthand property'];
      else if (t.isObjectMethod(n) && n.kind === 'method') hit = [2015, 'method shorthand'];
      else if ((t.isObjectProperty(n) || t.isObjectMethod(n)) && n.computed) hit = [2015, 'computed property'];
      else if (t.isFunction(n) && (n.generator || n.async) && !hit) hit = n.generator ? [2015, 'generator'] : [2017, 'async function'];
      if (hit && hit[0] > ecma && !seen.has(hit[1])) seen.set(hit[1], { since: hit[0], line: n.loc?.start.line ?? 0 });
    },
  });
  for (const [what, v] of [...seen].slice(0, 8)) {
    warn('target-syntax', `ES${v.since} syntax (${what}) at line ${v.line} is newer than the target ${label || 'ES' + ecma}; left as it is`);
  }
}

function virtualName(file: string, embedded: RefineInput['embedded']): string {
  if (!embedded) return file;
  return embedded.isModule ? `${file}.inline.mjs` : `${file}.inline.js`;
}

function detectJsx(ast: t.File): boolean {
  let jsx = false;
  traverse(ast, {
    JSXElement(p) {
      jsx = true;
      p.stop();
    },
    JSXFragment(p) {
      jsx = true;
      p.stop();
    },
  });
  return jsx;
}

const adviceCache = new WeakMap<object, Map<string, NamingAdvice | null>>();

function scopeChainNames(scope: Scope): Set<string> {
  const names = new Set<string>();
  let s: Scope | null = scope;
  while (s) {
    Object.keys(s.bindings).forEach((n) => names.add(n));
    s = s.parent;
  }
  return names;
}

export async function refineEcma(input: RefineInput, language: EcmaLanguage, formatter: FormatterAdapter): Promise<RefineOutput> {
  const { file, config, project, embedded } = input;
  const out: RefineOutput = { code: input.source, changes: [], suggestions: [], warnings: [] };
  const vfile = virtualName(file, embedded);
  const warn = (code: string, message: string) => out.warnings.push({ code, message, file });

  let baseAst: t.File;
  try {
    baseAst = parseEcma(input.source, vfile, language);
  } catch (e) {
    warn('syntax-error', `Skipped: could not parse (${errorMessage(e)})`);
    return out;
  }
  const isModule = baseAst.program.sourceType === 'module';
  const ecma = ecmaLevel(config, language);
  if (ecma < 9999) warnNewSyntax(baseAst, ecma, config.target[language] ?? config.target.javascript ?? '', warn);
  const hasJsx = detectJsx(baseAst);
  const originalSurface = surfaceOf(input.source, vfile, language);
  let current = input.source;

  // Classic-script globals may only be touched when nothing else can observe them.
  const policy = project.globalPolicy ?? 'never';
  const windowAccess = new Set([...input.source.matchAll(/\b(?:window|globalThis|self)\s*\.\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  const dynamicWindow = /\b(?:window|globalThis|self)\s*\[|\beval\s*\(|\bnew\s+Function\b|\bwith\s*\(/.test(input.source);
  const allowGlobal = (name: string): boolean =>
    policy === 'unreferenced' && !dynamicWindow && !windowAccess.has(name) && !project.protectedNames.has(name) && !(project.usedElsewhere?.(name, file) ?? false);

  const accept = (next: string, label: string, silent = false, renamed?: Set<string>): boolean => {
    const warnIf = silent ? () => undefined : warn;
    try {
      parseEcma(next, vfile, language);
    } catch (e) {
      warnIf('rule-rolled-back', `${label}: result did not parse again (${errorMessage(e)}); change reverted`);
      return false;
    }
    const surface = surfaceOf(next, vfile, language);
    const strip = (list: string[] | undefined) => (renamed?.size ? list?.filter((n) => !renamed.has(n)) : list);
    if (originalSurface && surface && strip(originalSurface)!.join('|') !== strip(surface)!.join('|')) {
      warnIf('rule-rolled-back', `${label}: exported/global names would change; change reverted`);
      return false;
    }
    return true;
  };

  // ---- Refactoring rules (Parse -> Transform -> Parse again) ------------------------------
  // Rules whose output needs newer syntax than the target are skipped (e.g. no `const` / arrow for ES5 or Rhino).
  const rules = rulesFor(ECMA_RULES, config.mode).filter((r) => !r.since || r.since <= ecma);
  const ctxFor = (src: string): EcmaRuleContext => ({ source: src, file, isModule, removeUnused: config.removeUnused, hasJsx, language, allowGlobal });

  // Fast path: every rule on one tree, one print, one verification. If anything looks wrong we
  // discard the result and redo the work rule by rule so a single bad rule cannot take others down.
  const fast = await (async (): Promise<{ code: string; changes: Change[]; suggestions: Suggestion[]; warnings: Warning[]; globalNames: Set<string> } | null> => {
    try {
      const ast = parseRecast(current, vfile, language);
      const ctx = ctxFor(current);
      const changes: Change[] = [];
      for (const rule of rules) {
        traverse.cache.clear(); // scopes must reflect earlier rules' edits
        for (const h of rule.apply(ast, ctx)) changes.push(hitToChange(h, rule, file, 'refactor'));
      }
      let suggestions: Suggestion[] = [];
      let warnings: Warning[] = [];
      let globalNames = new Set<string>();
      if (config.renameVariables) {
        traverse.cache.clear();
        const r = await applyRenames(ast, current, input);
        changes.push(...r.changes);
        suggestions = r.suggestions;
        warnings = r.warnings;
        globalNames = r.globalNames;
      }
      if (!changes.length) return { code: current, changes, suggestions, warnings, globalNames };
      const printed = printRecast(ast);
      return accept(printed, 'refactoring', true, globalNames) ? { code: printed, changes, suggestions, warnings, globalNames } : null;
    } catch {
      return null;
    }
  })();
  traverse.cache.clear();
  let renamedInFastPath = false;
  const surfaceChanges = new Set<string>();
  if (fast) {
    current = fast.code;
    out.changes.push(...fast.changes);
    out.suggestions.push(...fast.suggestions);
    out.warnings.push(...fast.warnings);
    fast.globalNames.forEach((n) => surfaceChanges.add(n));
    renamedInFastPath = true;
  } else {
    // Isolation path: one rule at a time, each verified on its own.
    for (const rule of rules) {
      let ast: t.File;
      try {
        ast = parseRecast(current, vfile, language);
      } catch (e) {
        warn('recast-failed', `${rule.id}: ${errorMessage(e)}`);
        break;
      }
      let hits;
      try {
        hits = rule.apply(ast, ctxFor(current));
      } catch (e) {
        warn('rule-failed', `${rule.id}: ${errorMessage(e)}`);
        continue;
      }
      if (!hits.length) continue;
      let printed: string;
      try {
        printed = printRecast(ast);
      } catch (e) {
        warn('rule-failed', `${rule.id}: could not print (${errorMessage(e)})`);
        continue;
      }
      if (!accept(printed, rule.id)) continue;
      current = printed;
      for (const h of hits) out.changes.push(hitToChange(h, rule, file, 'refactor'));
    }
  }

  // ---- Naming ------------------------------------------------------------------------------
  if (config.renameVariables && !renamedInFastPath) {
    const r = await renameStep(current, input, language, vfile, accept);
    current = r.code;
    out.changes.push(...r.changes);
    out.suggestions.push(...r.suggestions);
    out.warnings.push(...r.warnings);
    r.globalNames.forEach((n) => surfaceChanges.add(n));
  }

  // ---- Formatting ----------------------------------------------------------------------------
  if (!embedded) {
    try {
      const formatted = await formatter.format(current, file, { ecma });
      try {
        const a = parseEcma(current, vfile, language);
        const b = parseEcma(formatted, vfile, language);
        if (sameAst(a, b)) current = formatted;
        else warn('format-skipped', 'Formatter output was not equivalent to its input; left unformatted');
      } catch (e) {
        warn('format-skipped', `Formatter output did not parse (${errorMessage(e)}); left unformatted`);
      }
    } catch (e) {
      warn('format-failed', errorMessage(e));
    }
  }

  out.code = current;
  out.surfaceChanges = [...surfaceChanges];
  if (current !== input.source) {
    out.changes.push({ file, kind: 'format', ruleId: 'format', level: 'safe', description: `Formatted (${formatter.id})`, confidence: 1 });
  }
  return out;
}

async function renameStep(
  source: string,
  input: RefineInput,
  language: EcmaLanguage,
  vfile: string,
  accept: (next: string, label: string, silent?: boolean, renamed?: Set<string>) => boolean,
): Promise<{ code: string; changes: Change[]; suggestions: Suggestion[]; warnings: Warning[]; globalNames: Set<string> }> {
  const res = { code: source, changes: [] as Change[], suggestions: [] as Suggestion[], warnings: [] as Warning[], globalNames: new Set<string>() };
  let ast: t.File;
  try {
    ast = parseRecast(source, vfile, language);
  } catch {
    return res;
  }
  const r = await applyRenames(ast, source, input);
  res.changes = r.changes;
  res.suggestions = r.suggestions;
  res.warnings = r.warnings;
  res.globalNames = r.globalNames;
  if (r.renamed > 0) {
    let printed: string;
    try {
      printed = printRecast(ast);
    } catch (e) {
      res.warnings.push({ code: 'rename-rolled-back', file: input.file, message: `Rename could not be printed: ${errorMessage(e)}` });
      res.changes = [];
      res.suggestions = res.suggestions.filter((s) => !s.details?.applied);
      return res;
    }
    if (accept(printed, 'rename-variable', false, r.globalNames)) res.code = printed;
    else {
      res.changes = [];
      res.suggestions = res.suggestions.filter((s) => !s.details?.applied);
    }
  }
  return res;
}

/**
 * Two passes: renaming `x` to `activeStations` gives `for (const item of activeStations)` the
 * evidence it needs to become `activeStation`, which only exists once the first pass is done.
 */
async function applyRenames(
  ast: t.File,
  source: string,
  input: RefineInput,
): Promise<{ changes: Change[]; suggestions: Suggestion[]; warnings: Warning[]; renamed: number; globalNames: Set<string> }> {
  const first = await applyRenamesOnce(ast, source, input);
  if (first.renamed === 0) return first;
  traverse.cache.clear();
  const second = await applyRenamesOnce(ast, source, input);
  const key = (s: Suggestion) => `${s.loc?.line}:${s.loc?.column}`;
  const appliedLater = new Set(second.suggestions.filter((s) => s.details?.applied === true).map(key));
  const seen = new Set(first.suggestions.map((s) => `${key(s)}|${s.message}`));
  return {
    changes: [...first.changes, ...second.changes],
    suggestions: [
      ...first.suggestions.filter((s) => s.details?.applied === true || !appliedLater.has(key(s))),
      ...second.suggestions.filter((s) => !seen.has(`${key(s)}|${s.message}`)),
    ],
    warnings: [...first.warnings, ...second.warnings],
    renamed: first.renamed + second.renamed,
    globalNames: new Set([...first.globalNames, ...second.globalNames]),
  };
}

/** Finds poorly named bindings in `ast`, renames the confident ones in place and reports the rest. */
async function applyRenamesOnce(
  ast: t.File,
  source: string,
  input: RefineInput,
): Promise<{ changes: Change[]; suggestions: Suggestion[]; warnings: Warning[]; renamed: number; globalNames: Set<string> }> {
  const { file, config, project } = input;
  const res = { changes: [] as Change[], suggestions: [] as Suggestion[], warnings: [] as Warning[], renamed: 0, globalNames: new Set<string>() };
  const threshold = renameApplyThreshold(config);
  const abbreviations = new Set(project.naming.vocabulary.abbreviations.map((a) => a.abbreviation));

  const policy = project.globalPolicy ?? 'never';
  const windowAccess = new Set([...source.matchAll(/\b(?:window|globalThis|self)\s*\.\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  const dynamicWindow = /\b(?:window|globalThis|self)\s*\[|\beval\s*\(|\bnew\s+Function\b|\bwith\s*\(/.test(source);
  const allowGlobal = (name: string): boolean =>
    policy === 'unreferenced' && !dynamicWindow && !windowAccess.has(name) && !project.protectedNames.has(name) && !(project.usedElsewhere?.(name, file) ?? false);
  const targets = collectRenameTargets(ast, file, {
    allowGlobal,
    protectedNames: project.protectedNames,
    isCandidateName: (name) => splitWords(name).some((w) => abbreviations.has(w)),
  });
  if (!targets.length) return res;
  const programScope = targets[0].binding.scope.getProgramParent();

  for (const target of targets) {
    const { binding, subject } = target;
    const oldName = binding.identifier.name;
    subject.name = oldName;
    subject.takenNames = scopeChainNames(binding.scope);
    let candidates = proposeNames(subject, project.naming);
    if (!candidates.length) continue;

    const top = candidates[0];
    // Ask whenever local analysis is not fully sure. AI-assisted names are applied at `aiApplyThreshold`
    // in every mode, so enabling the advisor has a visible effect even in SAFE mode.
    if (project.advisor && (!top || top.confidence < config.thresholds.autoApply)) {
      const node = binding.path.node;
      const declSrc = node.start != null && node.end != null ? snippet(source.slice(node.start, node.end), 240) : undefined;
      const usages = binding.referencePaths.slice(0, 4).map((r) => {
        const st = r.getStatementParent()?.node;
        return st?.start != null && st.end != null ? snippet(source.slice(st.start, st.end), 160) : '';
      }).filter(Boolean);
      const fnParent = binding.path.getFunctionParent();
      const fnName = fnParent && (fnParent.isFunctionDeclaration() && fnParent.node.id ? fnParent.node.id.name : undefined) || undefined;
      const cacheKey = `${file}:${oldName}:${target.loc.line}:${target.loc.column}`;
      const cache = adviceCache.get(project) ?? adviceCache.set(project, new Map()).get(project)!;
      try {
        const advice = cache.has(cacheKey) ? cache.get(cacheKey)! : await project.advisor.adviseName({
          file,
          kind: subject.kind,
          currentName: oldName,
          valueType: subject.valueType,
          context: declSrc,
          usages,
          enclosingFunction: fnName,
          candidates: candidates.filter((c) => c.usable).slice(0, 5).map((c) => ({ name: c.name, score: c.score, evidence: c.evidence })),
          vocabulary: project.naming.vocabulary.entries.slice(0, 25).map((e) => e.word),
          convention: project.conventionNote,
          language: project.language,
        });
        cache.set(cacheKey, advice);
        candidates = withProposal(applyAdvice(candidates, advice, config.thresholds), advice, subject, config.thresholds, config.namingWeights);
      } catch {
        /* advisor failures never block local analysis */
      }
    }

    let applied = false;
    for (const c of candidates) {
      const needed = c.ai ? Math.min(threshold, config.aiApplyThreshold) : threshold;
      if (!c.usable || c.confidence < needed) continue;
      if (ecmaLevel(config, 'javascript') < 5 && ES3_RESERVED.has(c.name)) continue;
      if (conflictsWith(binding, c.name, programScope)) continue;
      binding.scope.rename(oldName, c.name);
      applied = true;
      res.renamed++;
      if (binding.scope.path.isProgram() && ast.program.sourceType !== 'module') {
        res.globalNames.add(`global:${oldName}`);
        res.globalNames.add(`global:${c.name}`);
      }
      const cls = classifyConfidence(c.confidence, config.thresholds);
      res.changes.push({
        file,
        kind: 'rename',
        ruleId: 'rename-variable',
        level: cls === 'auto' ? 'safe' : 'cautious',
        description: `Renamed ${subject.kind} "${oldName}" → "${c.name}"${binding.scope.path.isProgram() && ast.program.sourceType !== 'module' ? ' (global; no other file references it)' : ''}`,
        loc: target.loc,
        before: oldName,
        after: c.name,
        confidence: c.confidence,
      });
      res.suggestions.push({
        file,
        kind: 'rename',
        message: `Applied rename ${oldName} → ${c.name}`,
        loc: target.loc,
        confidence: c.confidence,
        candidates: candidates.filter((x) => x.confidence >= config.thresholds.suggest).slice(0, 5),
        details: { applied: true },
      });
      break;
    }
    if (!applied) {
      const shown = candidates.filter((c) => c.confidence >= config.thresholds.suggest);
      if (shown.length) {
        res.suggestions.push({
          file,
          kind: 'rename',
          message: `Candidate names for ${subject.kind} "${oldName}" (not applied)`,
          loc: target.loc,
          confidence: shown[0].confidence,
          candidates: shown.slice(0, 5),
          details: { applied: false, threshold },
        });
      }
    }
  }
  return res;
}
