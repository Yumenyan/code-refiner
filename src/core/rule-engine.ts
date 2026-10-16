import type { Change, Loc, RefactorLevel } from './types.js';
import { LEVEL_ORDER } from './types.js';

/**
 * A language-independent description of a refactoring rule. Language packs
 * implement `apply` against their own syntax tree type `T`.
 */
export interface Rule<T, C = unknown> {
  id: string;
  description: string;
  /** Lowest mode in which the rule runs. */
  level: RefactorLevel;
  /** Mutates `tree` in place and reports what it did. Must be conservative. */
  apply(tree: T, ctx: C): RuleHit[];
}

export interface RuleHit {
  description: string;
  loc?: Loc;
  before?: string;
  after?: string;
  /** 0..1, defaults to 1 for deterministic rules. */
  confidence?: number;
}

export function rulesFor<T, C>(rules: Rule<T, C>[], mode: RefactorLevel): Rule<T, C>[] {
  return rules.filter((r) => LEVEL_ORDER[r.level] <= LEVEL_ORDER[mode]);
}

export function hitToChange(
  hit: RuleHit,
  rule: Pick<Rule<unknown>, 'id' | 'level'>,
  file: string,
  kind: Change['kind'],
): Change {
  return {
    file,
    kind,
    ruleId: rule.id,
    level: rule.level,
    description: hit.description,
    loc: hit.loc,
    before: hit.before,
    after: hit.after,
    confidence: hit.confidence ?? 1,
  };
}
