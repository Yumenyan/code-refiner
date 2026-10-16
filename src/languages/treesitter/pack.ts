import { fingerprint } from '../../core/text.js';
import type { FileSemantic, FunctionInfo } from '../../semantic/model.js';
import type { FormatterAdapter, LanguagePack, SyntaxOutcome } from '../types.js';
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
      if (n.text.length) out.push(n.text);
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
    rules: [],
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
    async refine({ file, source }) {
      const out = { code: source, changes: [], suggestions: [], warnings: [] } as Awaited<ReturnType<LanguagePack['refine']>>;
      const warn = (code: string, message: string) => out.warnings.push({ code, message, file });
      const before = parse(source);
      if (before.rootNode.hasError) {
        before.delete();
        warn('syntax-error', 'Skipped: could not parse');
        return out;
      }
      const beforeLeaves = spec.equivalence === 'tokens' ? leaves(before.rootNode) : null;
      before.delete();
      if (!spec.formatter) return out;
      try {
        const formatted = await spec.formatter.format(source, file);
        if (formatted === source) return out;
        const after = parse(formatted);
        const bad = after.rootNode.hasError;
        const same = !beforeLeaves || (() => {
          const a = leaves(after.rootNode);
          return a.length === beforeLeaves.length && a.every((x, i) => x === beforeLeaves[i]);
        })();
        after.delete();
        if (bad) warn('format-skipped', 'Formatter output did not parse; left unformatted');
        else if (!same) warn('format-skipped', 'Formatter changed more than whitespace; left unformatted');
        else {
          out.code = formatted;
          out.changes.push({ file, kind: 'format', ruleId: 'format', level: 'safe', description: `Formatted (${spec.formatter.id})`, confidence: 1 });
        }
      } catch (e) {
        warn('format-failed', (e as Error).message.split('\n')[0]);
      }
      return out;
    },
    isEquivalent: spec.equivalence === 'trust' ? undefined : (a, b) => {
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
