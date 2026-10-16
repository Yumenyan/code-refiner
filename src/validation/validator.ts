import { extname } from '../core/text.js';
import type { Config } from '../core/config.js';
import type { Warning } from '../core/types.js';
import type { LanguageRegistry } from '../languages/registry.js';
import { regressions, typecheckProject } from './typecheck.js';

export interface FileState {
  path: string;
  language?: string;
  original: string;
  refined: string;
  /** Rule ids that touched the file besides pure formatting. */
  semanticRules: string[];
}

export interface ValidationCheck {
  name: string;
  status: 'passed' | 'failed' | 'skipped' | 'rolled-back';
  file?: string;
  detail?: string;
}

export interface ValidationReport {
  enabled: boolean;
  checks: ValidationCheck[];
  rolledBack: string[];
  warnings: Warning[];
}

/**
 * Independent safety gate after all transformations. Every check can only
 * *reject* a change (rolling the file back); none of them can create changes.
 *
 *   Parse again -> surface check -> formatting equivalence -> type check
 */
export async function validateFiles(
  states: FileState[],
  registry: LanguageRegistry,
  config: Config,
): Promise<ValidationReport> {
  const report: ValidationReport = { enabled: true, checks: [], rolledBack: [], warnings: [] };
  const rollback = (s: FileState, why: string, check: string) => {
    s.refined = s.original;
    report.rolledBack.push(s.path);
    report.checks.push({ name: check, status: 'rolled-back', file: s.path, detail: why });
    report.warnings.push({ code: 'rolled-back', file: s.path, message: `Reverted to the original: ${why}` });
  };

  const changed = states.filter((s) => s.refined !== s.original);
  let syntaxOk = 0;
  for (const s of changed) {
    const pack = s.language ? registry.get(s.language) ?? registry.forFile(s.path) : registry.forFile(s.path);
    if (!pack) continue;
    const syntax = await pack.checkSyntax(s.refined, s.path);
    if (!syntax.ok) {
      rollback(s, `output no longer parses (${syntax.error ?? 'syntax error'})`, 'syntax');
      continue;
    }
    syntaxOk++;
    if (pack.surface) {
      const before = pack.surface(s.original, s.path);
      const after = pack.surface(s.refined, s.path);
      if (before && after && before.join('|') !== after.join('|')) {
        rollback(s, 'exported / global names changed', 'surface');
        continue;
      }
    }
    if (s.semanticRules.length === 0 && pack.isEquivalent) {
      const eq = pack.isEquivalent(s.original, s.refined, s.path);
      if (eq === false) {
        rollback(s, 'formatting changed the meaning of the file', 'equivalence');
        continue;
      }
    }
  }
  report.checks.push({ name: 'syntax', status: changed.length ? 'passed' : 'skipped', detail: `${syntaxOk}/${changed.length} changed files parse again` });

  // Type check (TypeScript projects): refined must not introduce new diagnostics.
  if (config.validationOptions.typecheck) {
    const originalFiles = new Map(states.map((s) => [s.path, s.original]));
    const base = typecheckProject(originalFiles);
    if (!base.ran) {
      report.checks.push({ name: 'typecheck', status: 'skipped', detail: base.reason });
    } else {
      let refinedFiles = new Map(states.map((s) => [s.path, s.refined]));
      let after = typecheckProject(refinedFiles);
      let bad = regressions(base, after);
      if (bad.length) {
        for (const path of bad) {
          const s = states.find((x) => x.path === path);
          if (s && s.refined !== s.original) rollback(s, 'introduced new TypeScript diagnostics', 'typecheck');
        }
        refinedFiles = new Map(states.map((s) => [s.path, s.refined]));
        after = typecheckProject(refinedFiles);
        bad = regressions(base, after);
        // A rename in one file can break a use in another; fall back to the originals of every changed TS file.
        if (bad.length) {
          for (const s of states) {
            if (s.refined !== s.original && ['.ts', '.tsx', '.mts', '.cts'].includes(extname(s.path))) rollback(s, 'type check regressions could not be isolated', 'typecheck');
          }
          after = typecheckProject(new Map(states.map((s) => [s.path, s.refined])));
        }
      }
      report.checks.push({ name: 'typecheck', status: regressions(base, after).length ? 'failed' : 'passed', detail: `${base.total} diagnostics before, ${after.total} after` });
    }
  } else report.checks.push({ name: 'typecheck', status: 'skipped', detail: 'disabled' });

  return report;
}

export function disabledReport(): ValidationReport {
  return { enabled: false, checks: [{ name: 'validation', status: 'skipped', detail: 'disabled by configuration' }], rolledBack: [], warnings: [] };
}
