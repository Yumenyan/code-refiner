import { fingerprint } from '../../core/text.js';
import type { Suggestion } from '../../core/types.js';
import type { FileSemantic, FunctionInfo } from '../../semantic/model.js';
import type { FormatterAdapter, LanguagePack, SyntaxOutcome } from '../types.js';
import { inferIndent } from '../prettier.js';
import { reflow } from './reflow.js';
import { ADAPTERS } from './lang-adapters.js';
import { applyEdits, planRenames, ruleEdits, TS_RULES } from './refactor.js';
import { loadLanguage, newParser, type Parser, type SyntaxNode } from './runtime.js';

export interface TreeSitterSpec {
  id: string;
  displayName: string;
  extensions: string[];
  /** File name inside tree-sitter-wasms/out (e.g. tree-sitter-java.wasm). */
  wasm: string;
  /** Node types that define a function / method. */
  functionTypes: string[];
  /** Node types counted as identifiers for the project vocabulary. */
  identifierTypes?: string[];
  /** Whitespace-only formatter. Output is accepted only if the token stream is provably unchanged. */
  formatter?: FormatterAdapter | null;
  /** How to prove a formatter did not change meaning. */
  equivalence?: 'tokens' | 'trust';
  /** Built-in whitespace-only layout used when no native formatter is available (always verified). */
  reflow?: { indent?: string };
}

const BRANCH = new Set([
  'if_statement', 'if_expression', 'elif_clause', 'else_if', 'if', 'unless', 'elsif', 'for_statement', 'for_in_statement',
  'enhanced_for_statement', 'for_expression', 'foreach_statement', 'for_range_loop', 'for', 'while_statement', 'while_expression',
  'while', 'until', 'do_statement', 'do_while_statement', 'switch_label', 'switch_section', 'switch_block_statement_group',
  'case_statement', 'case_clause', 'expression_case', 'type_case', 'communication_case', 'when_entry', 'when', 'match_arm',
  'catch_clause', 'except_clause', 'rescue', 'ternary_expression', 'conditional_expression', 'conditional', 'elvis_expression',
]);
const NEST = new Set([
  'if_statement', 'if_expression', 'for_statement', 'for_in_statement', 'enhanced_for_statement', 'for_expression',
  'foreach_statement', 'for_range_loop', 'while_statement', 'while_expression', 'do_statement', 'switch_statement',
  'switch_expression', 'try_statement', 'match_expression', 'when_expression', 'case', 'for', 'while', 'if', 'unless',
]);
const NAME_FIELDS = ['name', 'declarator'];
const PARAM_FIELDS = ['parameters', 'formal_parameters', 'parameter_list', 'parameter'];
const LOGICAL = new Set(['&&', '||', 'and', 'or', '??']);

function firstError(root: SyntaxNode): { line: number; column: number; text: string } | null {
  const stack: SyntaxNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'ERROR' || n.isMissing) {
      return { line: n.startPosition.row + 1, column: n.startPosition.column + 1, text: n.isMissing ? `missing ${n.type}` : n.text.slice(0, 30) };
    }
    if (!n.hasError) continue;
    for (let i = n.childCount - 1; i >= 0; i--) stack.push(n.child(i)!);
  }
  return null;
}

/** Leaf text sequence: equal sequences mean the two files differ only by whitespace. */
function leaves(root: SyntaxNode): string[] {
  const out: string[] = [];
  const walk = (n: SyntaxNode): void => {
    if (n.childCount === 0) {
      if (n.text.trim()) out.push(n.text); // whitespace-only leaves are automatic semicolons / layout
      return;
    }
    for (let i = 0; i < n.childCount; i++) walk(n.child(i)!);
  };
  walk(root);
  return out;
}

function nodeName(n: SyntaxNode): string {
  for (const f of NAME_FIELDS) {
    const c = n.childForFieldName(f);
    if (c) {
      // C/C++: function_declarator wraps the identifier
      let cur: SyntaxNode | null = c;
      while (cur && cur.childForFieldName('declarator')) cur = cur.childForFieldName('declarator');
      return (cur ?? c).childForFieldName('name')?.text ?? (cur ?? c).text.split('(')[0].trim();
    }
  }
  return `<anonymous>@${n.startPosition.row + 1}`;
}

function paramCount(n: SyntaxNode): number {
  let params: SyntaxNode | null = null;
  for (const f of PARAM_FIELDS) params ??= n.childForFieldName(f);
  if (!params) {
    const decl = n.childForFieldName('declarator');
    if (decl) for (const f of PARAM_FIELDS) params ??= decl.childForFieldName(f);
  }
  return params ? params.namedChildren.filter((c) => !/comment/.test(c.type)).length : 0;
}

function measure(fn: SyntaxNode): { cyclomatic: number; maxNesting: number; size: number; hash: string } {
  let cyclomatic = 1;
  let maxNesting = 0;
  let size = 0;
  const parts: string[] = [];
  const visit = (n: SyntaxNode, depth: number, isRoot: boolean): void => {
    size++;
    if (BRANCH.has(n.type)) cyclomatic++;
    if ((n.type === 'binary_expression' || n.type === 'boolean_operator' || n.type === 'binary_operator') && LOGICAL.has(n.childForFieldName('operator')?.text ?? n.children.find((c) => !c.isNamed)?.text ?? '')) cyclomatic++;
    let d = depth;
    if (NEST.has(n.type)) {
      d++;
      maxNesting = Math.max(maxNesting, d);
    }
    if (/^(identifier|type_identifier|field_identifier|property_identifier|string|string_literal|number|integer|float|decimal_integer_literal|integer_literal|string_content|comment|line_comment|block_comment)/.test(n.type) && n.childCount === 0) {
      parts.push(n.type.includes('comment') ? '' : n.type.split('_')[0]);
      return;
    }
    parts.push(n.type + '(');
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i)!;
      if (isRoot && NAME_FIELDS.includes(n.fieldNameForChild(i) ?? '')) continue; // the function's own name does not matter
      visit(c, d, false);
    }
    parts.push(')');
  };
  visit(fn, 0, true);
  return { cyclomatic, maxNesting, size, hash: fingerprint(parts.join(' ')) };
}

export function treeSitterPack(spec: TreeSitterSpec): LanguagePack & { init(): Promise<void> } {
  let parser: Parser | null = null;
  const functionTypes = new Set(spec.functionTypes);
  const identTypes = new Set(spec.identifierTypes ?? ['identifier', 'type_identifier', 'field_identifier', 'property_identifier', 'constant', 'simple_identifier']);

  const parse = (source: string) => {
    if (!parser) throw new Error(`${spec.displayName} parser is not initialised`);
    return parser.parse(source);
  };

  const pack: LanguagePack & { init(): Promise<void> } = {
    id: spec.id,
    displayName: spec.displayName,
    extensions: spec.extensions,
    formatter: spec.formatter ?? { id: 'none', format: async (s) => s },
    rules: (TS_RULES[spec.id] ?? []).map((r) => ({ ...r })),
    async init() {
      if (!parser) parser = newParser(await loadLanguage(spec.wasm));
    },
    checkSyntax(source): SyntaxOutcome {
      const tree = parse(source);
      const err = tree.rootNode.hasError ? firstError(tree.rootNode) : null;
      tree.delete();
      return err ? { ok: false, error: `syntax error at ${err.line}:${err.column} (${err.text})` } : { ok: true };
    },
    analyze({ file, source }) {
      try {
        const tree = parse(source);
        if (tree.rootNode.hasError) {
          tree.delete();
          return {};
        }
        const functions: FunctionInfo[] = [];
        const functionHashes: FileSemantic['functionHashes'] = [];
        const counts: Record<string, number> = Object.create(null);
        const walk = (n: SyntaxNode): void => {
          if (n.childCount === 0 && identTypes.has(n.type)) counts[n.text] = (counts[n.text] ?? 0) + 1;
          if (functionTypes.has(n.type)) {
            const m = measure(n);
            const name = nodeName(n);
            const line = n.startPosition.row + 1;
            const lines = n.endPosition.row - n.startPosition.row + 1;
            const id = `${file}::${name}@${line}`;
            functions.push({ id, name, file, loc: { line, column: n.startPosition.column + 1 }, params: Array.from({ length: paramCount(n) }, (_, i) => `p${i}`), returnsValue: true, async: false, generator: false, exported: false, lines, cyclomatic: m.cyclomatic, maxNesting: m.maxNesting, calls: [] });
            if (m.size >= 30) functionHashes.push({ id, name, loc: { line, column: 1 }, hash: m.hash, size: m.size, lines });
          }
          for (let i = 0; i < n.childCount; i++) walk(n.child(i)!);
        };
        walk(tree.rootNode);
        tree.delete();
        const semantic: FileSemantic = {
          file, language: spec.id, variables: [], functions, module: { file, isModule: false, imports: [], exports: [] },
          dataFlow: [], calls: [], domRefs: [], unreachable: [], strings: [], functionHashes, hasDynamicScope: false, identifierCounts: counts,
        };
        return { semantic };
      } catch {
        return {};
      }
    },
    async refine({ file, source, config, project }) {
      const out = { code: source, changes: [], suggestions: [], warnings: [] } as Awaited<ReturnType<LanguagePack['refine']>>;
      const warn = (code: string, message: string) => out.warnings.push({ code, message, file });
      const first = parse(source);
      if (first.rootNode.hasError) {
        first.delete();
        warn('syntax-error', 'Skipped: could not parse');
        return out;
      }
      first.delete();
      let current = source;
      const adapter = ADAPTERS[spec.id];

      // ---- 1. safe, language specific rules (text edits, re-parsed) ----------------------------------
      if (adapter) {
        const tree = parse(current);
        const edits = ruleEdits(spec.id, tree.rootNode, current);
        tree.delete();
        if (edits.length) {
          const candidate = applyEdits(current, edits);
          const check = parse(candidate);
          const ok = !check.rootNode.hasError;
          check.delete();
          if (ok) {
            current = candidate;
            for (const e of edits) out.changes.push({ file, kind: 'refactor', ruleId: e.ruleId, level: 'safe', description: e.description, loc: { line: e.line, column: 1 }, confidence: 1 });
          } else warn('rule-rolled-back', `${spec.displayName} rules: result did not parse again; reverted`);
        }
      }

      // ---- 2. renames from data flow (+ optional AI), proven token by token ----------------------------
      // Two passes: the first rename (`x` -> `active_stations`) is the evidence the second one needs.
      if (adapter && config.renameVariables) {
        const key = (sg: Suggestion) => `${sg.loc?.line}|${(sg.message.match(/"([^"]+)"/) ?? sg.message.match(/rename (\S+) →/) ?? [])[1]}`;
        for (let pass = 0; pass < 2; pass++) {
          const tree = parse(current);
          const plan = await planRenames({ a: adapter, root: tree.rootNode, source: current, file, config, project });
          const beforeLeaves = leaves(tree.rootNode);
          const beforeShape = tree.rootNode.toString();
          tree.delete();
          const appliedKeys = new Set(plan.suggestions.filter((x) => x.details?.applied === true).map(key));
          const have = new Set(out.suggestions.map((x) => `${key(x)}|${x.message}`));
          out.suggestions = out.suggestions.filter((x) => x.details?.applied === true || !appliedKeys.has(key(x)));
          out.suggestions.push(...plan.suggestions.filter((x) => !have.has(`${key(x)}|${x.message}`)));
          if (!plan.edits.length) break;
          const candidate = applyEdits(current, plan.edits);
          const check = parse(candidate);
          const after = leaves(check.rootNode);
          const ok =
            !check.rootNode.hasError &&
            check.rootNode.toString() === beforeShape &&
            after.length === beforeLeaves.length &&
            after.every((x, i) => x === beforeLeaves[i] || plan.renamedPairs.has(`${beforeLeaves[i]}\u0000${x}`));
          check.delete();
          if (!ok) {
            out.suggestions = out.suggestions.filter((x) => x.details?.applied !== true);
            warn('rule-rolled-back', `${spec.displayName} renames: the result changed more than the renamed identifiers; reverted`);
            break;
          }
          current = candidate;
          out.changes.push(...plan.changes);
        }
      }

      // ---- 3. formatting: native tool, or the built-in whitespace-only layout ----------------------------
      const before = parse(current);
      const useBuiltin = !spec.formatter && !!spec.reflow;
      const proof = useBuiltin || spec.equivalence === 'tokens';
      const beforeLeaves = proof ? leaves(before.rootNode) : null;
      const beforeShape = proof ? before.rootNode.toString() : '';
      let builtinText: string | null = null;
      if (useBuiltin) {
        const ind = spec.reflow!.indent ?? (() => {
          const i = inferIndent(source);
          return i?.useTabs ? '\t' : ' '.repeat(i?.tabWidth ?? 4);
        })();
        builtinText = reflow(current, before.rootNode, { indent: ind, splitStatements: true });
      }
      before.delete();
      if (spec.formatter || builtinText) {
        const formatterId = spec.formatter?.id ?? 'builtin-reflow';
        try {
          const formatted = builtinText ?? (await spec.formatter!.format(current, file, { edition: config?.target?.[spec.id] }));
          if (formatted !== current) {
            const after = parse(formatted);
            const bad = after.rootNode.hasError;
            // Same tokens in the same order AND the same tree shape: only whitespace can have changed.
            const same = !beforeLeaves || (() => {
              const a = leaves(after.rootNode);
              return a.length === beforeLeaves.length && a.every((x, i) => x === beforeLeaves[i]) && after.rootNode.toString() === beforeShape;
            })();
            after.delete();
            if (bad) warn('format-skipped', 'Formatter output did not parse; left unformatted');
            else if (!same) warn('format-skipped', 'Formatter changed more than whitespace; left unformatted');
            else {
              current = formatted;
              out.changes.push({ file, kind: 'format', ruleId: 'format', level: 'safe', description: `Formatted (${formatterId})`, confidence: 1 });
            }
          }
        } catch (e) {
          warn('format-failed', (e as Error).message.split('\n')[0]);
        }
      }
      out.code = current;
      return out;
    },
    isEquivalent: spec.equivalence === 'trust' && !spec.reflow ? undefined : (a, b) => {
      try {
        const ta = parse(a);
        const tb = parse(b);
        const r = leaves(ta.rootNode).join('\u0000') === leaves(tb.rootNode).join('\u0000');
        ta.delete();
        tb.delete();
        return r;
      } catch {
        return undefined;
      }
    },
  };
  return pack;
}
