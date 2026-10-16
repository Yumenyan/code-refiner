import * as t from '@babel/types';
import { renameApplyThreshold } from '../../core/config.js';
import { hitToChange, rulesFor } from '../../core/rule-engine.js';
import type { Change, Suggestion, Warning } from '../../core/types.js';
import { snippet } from '../../core/text.js';
import { applyAdvice, classifyConfidence, proposeNames } from '../../naming/engine.js';
import { splitWords } from '../../naming/words.js';
import type { FormatterAdapter, RefineInput, RefineOutput } from '../types.js';
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
  const hasJsx = detectJsx(baseAst);
  const originalSurface = surfaceOf(input.source, vfile, language);
  let current = input.source;

  const accept = (next: string, label: string, silent = false): boolean => {
    const warnIf = silent ? () => undefined : warn;
    try {
      parseEcma(next, vfile, language);
    } catch (e) {
      warnIf('rule-rolled-back', `${label}: result did not parse again (${errorMessage(e)}); change reverted`);
      return false;
    }
    const surface = surfaceOf(next, vfile, language);
    if (originalSurface && surface && originalSurface.join('|') !== surface.join('|')) {
      warnIf('rule-rolled-back', `${label}: exported/global names would change; change reverted`);
      return false;
    }
    return true;
  };

  // ---- Refactoring rules (Parse -> Transform -> Parse again) ------------------------------
  const rules = rulesFor(ECMA_RULES, config.mode);
  const ctxFor = (src: string): EcmaRuleContext => ({ source: src, file, isModule, removeUnused: config.removeUnused, hasJsx, language });

  // Fast path: every rule on one tree, one print, one verification. If anything looks wrong we
  // discard the result and redo the work rule by rule so a single bad rule cannot take others down.
  const fast = await (async (): Promise<{ code: string; changes: Change[]; suggestions: Suggestion[]; warnings: Warning[] } | null> => {
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
      if (config.renameVariables) {
        traverse.cache.clear();
        const r = await applyRenames(ast, current, input);
        changes.push(...r.changes);
        suggestions = r.suggestions;
        warnings = r.warnings;
      }
      if (!changes.length) return { code: current, changes, suggestions, warnings };
      const printed = printRecast(ast);
      return accept(printed, 'refactoring', true) ? { code: printed, changes, suggestions, warnings } : null;
    } catch {
      return null;
    }
  })();
  traverse.cache.clear();
  let renamedInFastPath = false;
  if (fast) {
    current = fast.code;
    out.changes.push(...fast.changes);
    out.suggestions.push(...fast.suggestions);
    out.warnings.push(...fast.warnings);
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
  }

  // ---- Formatting ----------------------------------------------------------------------------
  if (!embedded) {
    try {
      const formatted = await formatter.format(current, file);
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
  accept: (next: string, label: string) => boolean,
): Promise<{ code: string; changes: Change[]; suggestions: Suggestion[]; warnings: Warning[] }> {
  const res = { code: source, changes: [] as Change[], suggestions: [] as Suggestion[], warnings: [] as Warning[] };
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
    if (accept(printed, 'rename-variable')) res.code = printed;
    else {
      res.changes = [];
      res.suggestions = res.suggestions.filter((s) => !s.details?.applied);
    }
  }
  return res;
}

/** Finds poorly named bindings in `ast`, renames the confident ones in place and reports the rest. */
async function applyRenames(
  ast: t.File,
  source: string,
  input: RefineInput,
): Promise<{ changes: Change[]; suggestions: Suggestion[]; warnings: Warning[]; renamed: number }> {
  const { file, config, project } = input;
  const res = { changes: [] as Change[], suggestions: [] as Suggestion[], warnings: [] as Warning[], renamed: 0 };
  const threshold = renameApplyThreshold(config);
  const abbreviations = new Set(project.naming.vocabulary.abbreviations.map((a) => a.abbreviation));

  const targets = collectRenameTargets(ast, file, {
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
    if (project.advisor && top.confidence >= config.thresholds.suggest && top.confidence < config.thresholds.autoApply) {
      const declSrc = binding.path.node.start != null && binding.path.node.end != null ? snippet(source.slice(binding.path.node.start, binding.path.node.end), 160) : undefined;
      try {
        const advice = await project.advisor.adviseName({
          file,
          kind: subject.kind,
          currentName: oldName,
          valueType: subject.valueType,
          context: declSrc,
          candidates: candidates.filter((c) => c.usable).slice(0, 5).map((c) => ({ name: c.name, score: c.score, evidence: c.evidence })),
          vocabulary: project.naming.vocabulary.entries.slice(0, 25).map((e) => e.word),
        });
        candidates = applyAdvice(candidates, advice, config.thresholds);
      } catch {
        /* advisor failures never block local analysis */
      }
    }

    let applied = false;
    for (const c of candidates) {
      if (!c.usable || c.confidence < threshold) continue;
      if (conflictsWith(binding, c.name, programScope)) continue;
      binding.scope.rename(oldName, c.name);
      applied = true;
      res.renamed++;
      const cls = classifyConfidence(c.confidence, config.thresholds);
      res.changes.push({
        file,
        kind: 'rename',
        ruleId: 'rename-variable',
        level: cls === 'auto' ? 'safe' : 'cautious',
        description: `Renamed ${subject.kind} "${oldName}" → "${c.name}"`,
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
