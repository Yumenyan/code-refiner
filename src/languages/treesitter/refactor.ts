import { renameApplyThreshold } from '../../core/config.js';
import type { Config } from '../../core/config.js';
import type { Change, Suggestion, Warning } from '../../core/types.js';
import { snippet } from '../../core/text.js';
import { applyAdvice, classifyConfidence, proposeNames, withProposal } from '../../naming/engine.js';
import type { Fact, NamingSubject, ValueType } from '../../naming/facts.js';
import { isPoorName, isValidIdentifier, singularize, splitWords } from '../../naming/words.js';
import { wordsOfIdentifierName } from '../javascript/value-facts.js';
import type { ProjectContext } from '../types.js';
import type { Decl, LangAdapter } from './lang-adapters.js';
import type { SyntaxNode } from './runtime.js';

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

export function applyEdits(source: string, edits: TextEdit[]): string {
  let out = source;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

const loc = (n: SyntaxNode) => ({ line: n.startPosition.row + 1, column: n.startPosition.column + 1 });
const f = (n: SyntaxNode, name: string) => n.childForFieldName(name);

function descend(n: SyntaxNode, fn: (c: SyntaxNode) => void): void {
  fn(n);
  for (let i = 0; i < n.childCount; i++) descend(n.child(i)!, fn);
}

const WRAPPERS = /^(parenthesized_expression|try_expression|await_expression|reference_expression|cast_expression|as_expression|type_cast_expression|non_null_expression|unary_expression)$/;
function unwrap(n: SyntaxNode): SyntaxNode {
  let cur = n;
  while (WRAPPERS.test(cur.type) && cur.namedChildCount === 1) cur = cur.namedChildren[0];
  return cur.type === 'reference_expression' ? (f(cur, 'value') ?? cur) : cur;
}

// Method vocabulary shared by iterator / stream / LINQ / list-comprehension style APIs.
const FILTER = new Set(['filter', 'Where', 'where', 'filter_map', 'takeWhile', 'take_while', 'skip_while', 'TakeWhile']);
const MAP = new Set(['map', 'Select', 'select', 'flat_map', 'flatMap', 'SelectMany']);
const FIND = new Set(['find', 'First', 'FirstOrDefault', 'first', 'Find', 'Single', 'SingleOrDefault', 'findFirst', 'findAny', 'find_map', 'position']);
const LENGTH = new Set(['len', 'count', 'size', 'length', 'Count', 'Length']);
const SOME = new Set(['any', 'all', 'Any', 'All', 'anyMatch', 'allMatch', 'noneMatch', 'contains', 'Contains', 'is_empty', 'isEmpty', 'IsEmpty']);
const SORT = new Set(['sort', 'sorted', 'OrderBy', 'OrderByDescending', 'sort_by', 'sort_by_key', 'sort_unstable']);
const SUM = new Set(['sum', 'Sum', 'reduce', 'fold', 'Aggregate']);
const COLLECT = new Set(['collect', 'to_vec', 'toList', 'ToList', 'ToArray', 'toArray', 'to_owned', 'cloned', 'copied', 'list', 'tolist', 'AsEnumerable', 'boxed', 'Collect', 'clone', 'unwrap', 'iter', 'iter_mut', 'into_iter', 'stream', 'values', 'AsQueryable']);
const PRESERVING = new Set([...FILTER, ...COLLECT, 'skip', 'take', 'rev', 'Skip', 'Take', 'Reverse', 'peekable', 'inspect', 'chain', 'sorted', 'sort', 'OrderBy', 'distinct', 'Distinct']);
const ITERATING = new Set([...FILTER, ...MAP, ...FIND, ...SOME, ...SUM, 'for_each', 'forEach', 'ForEach', 'max_by_key', 'min_by_key', 'filter_map', 'partition', 'OrderBy', 'GroupBy']);

interface Chain {
  root: SyntaxNode;
  calls: { method: string; args: SyntaxNode[]; node: SyntaxNode }[];
}

function chainOf(a: LangAdapter, expr: SyntaxNode): Chain {
  const calls: Chain['calls'] = [];
  let cur = unwrap(expr);
  for (let guard = 0; guard < 40; guard++) {
    const shape = a.callShape(cur);
    if (!shape) break;
    calls.unshift({ method: shape.method, args: shape.args, node: cur });
    if (!shape.object) return { root: cur, calls };
    cur = unwrap(shape.object);
  }
  return { root: cur, calls };
}

function rootWords(a: LangAdapter, root: SyntaxNode): { words: string[]; plural: boolean } | null {
  if (a.identifierTypes.has(root.type)) return wordsOfIdentifierName(root.text);
  const m = a.member(root);
  return m ? wordsOfIdentifierName(m.name) : null;
}

/** First member read on `param` inside a lambda body: `|s| s.active`, `s -> s.isActive()`, `s => s.Active`. */
function memberOnParam(a: LangAdapter, body: SyntaxNode | null, param: string): { name: string; direct: boolean } | null {
  if (!body) return null;
  let found: { name: string; direct: boolean } | null = null;
  descend(body, (n) => {
    if (found) return;
    const m = a.member(n);
    if (m && a.identifierTypes.has(m.object.type) && m.object.text === param) found = { name: m.name, direct: n.id === body.id || (body.namedChildCount === 1 && body.namedChildren[0].id === n.id) || /^(block|statement_block)$/.test(body.type) };
  });
  return found;
}

function lambdaParam(a: LangAdapter, arg: SyntaxNode | undefined): { name: string; body: SyntaxNode | null } | null {
  if (!arg) return null;
  const l = a.lambdaShape(arg);
  return l && l.params[0] ? { name: l.params[0].text, body: l.body } : null;
}

/** Turns an initializer into the facts the naming engine understands. */
function initFacts(a: LangAdapter, init: SyntaxNode): { facts: Fact[]; valueType: ValueType } {
  const facts: Fact[] = [];
  let valueType: ValueType = a.literalType(init) ?? 'unknown';

  // Python list comprehension: [s.name for s in stations if s.active]
  if (init.type === 'list_comprehension' && a.id === 'python') {
    const clauses = init.namedChildren.filter((c) => c.type === 'for_in_clause' || c.type === 'if_clause');
    const forIn = clauses.find((c) => c.type === 'for_in_clause');
    const cond = clauses.find((c) => c.type === 'if_clause');
    const iterable = forIn ? f(forIn, 'right') : null;
    const varName = forIn ? f(forIn, 'left')?.text : undefined;
    const w = iterable ? rootWords(a, chainOf(a, iterable).root) : null;
    if (w && varName) {
      facts.push({ type: 'source', words: w.words, plural: w.plural });
      const pred = cond ? memberOnParam(a, cond, varName) : null;
      const proj = memberOnParam(a, f(init, 'body'), varName);
      if (pred) {
        facts.push({ type: 'method', name: 'filter' }, { type: 'property', name: pred.name, role: 'predicate' });
      } else if (proj?.direct) facts.push({ type: 'method', name: 'map' }, { type: 'property', name: proj.name, role: 'projection' });
    }
    return { facts, valueType: 'array' };
  }

  const chain = chainOf(a, init);
  if (!chain.calls.length) return { facts, valueType };
  const first = chain.calls[0];
  // plain call `calc_total(...)`: the callee names the result
  if (chain.calls.length === 1 && chain.root.id === first.node.id) {
    // len(xs) / sorted(xs): the argument is the collection
    const arg = first.args[0] ? unwrap(first.args[0]) : null;
    const w = arg ? (a.identifierTypes.has(arg.type) ? wordsOfIdentifierName(arg.text) : (() => { const m = a.member(arg); return m ? wordsOfIdentifierName(m.name) : null; })()) : null;
    if (w && LENGTH.has(first.method) && first.args.length === 1) return { facts: [{ type: 'source', words: w.words, plural: w.plural }, { type: 'method', name: 'length' }], valueType: 'number' };
    if (w && SORT.has(first.method) && first.args.length === 1) return { facts: [{ type: 'source', words: w.words, plural: w.plural }, { type: 'method', name: 'sort' }], valueType: 'array' };
    return { facts: [{ type: 'call', callee: first.method }], valueType };
  }
  const w = rootWords(a, chain.root);
  const meaningful = [...chain.calls].reverse().find((c) => !COLLECT.has(c.method));
  const collected = chain.calls.some((c) => COLLECT.has(c.method) && !/^(iter|iter_mut|into_iter|stream|values|unwrap|clone)$/.test(c.method));
  if (!meaningful) return { facts, valueType: collected ? 'array' : valueType };
  const m = meaningful.method;
  const lam = lambdaParam(a, meaningful.args[0]);
  const addSource = () => w && facts.push({ type: 'source', words: w.words, plural: w.plural });
  if (FILTER.has(m)) {
    addSource();
    facts.push({ type: 'method', name: 'filter' });
    const pred = lam ? memberOnParam(a, lam.body, lam.name) : null;
    if (pred) facts.push({ type: 'property', name: pred.name, role: 'predicate' });
    valueType = 'array';
  } else if (MAP.has(m)) {
    addSource();
    facts.push({ type: 'method', name: 'map' });
    const proj = lam ? memberOnParam(a, lam.body, lam.name) : null;
    if (proj?.direct) facts.push({ type: 'property', name: proj.name, role: 'projection' });
    valueType = 'array';
  } else if (FIND.has(m)) {
    addSource();
    facts.push({ type: 'method', name: 'find' });
    const pred = lam ? memberOnParam(a, lam.body, lam.name) : null;
    if (pred) facts.push({ type: 'property', name: pred.name, role: 'predicate' });
  } else if (LENGTH.has(m)) {
    addSource();
    facts.push({ type: 'method', name: 'length' });
    valueType = 'number';
  } else if (SOME.has(m)) {
    addSource();
    facts.push({ type: 'method', name: 'some' });
    valueType = 'boolean';
  } else if (SORT.has(m)) {
    addSource();
    facts.push({ type: 'method', name: 'sort' });
    valueType = 'array';
  } else if (SUM.has(m)) {
    // `xs.iter().map(|s| s.price).sum()` -> total_price
    const mapCall = chain.calls.find((c) => MAP.has(c.method));
    const l2 = mapCall ? lambdaParam(a, mapCall.args[0]) : null;
    const proj = l2 ? memberOnParam(a, l2.body, l2.name) : null;
    if (w && proj?.direct) {
      facts.push({ type: 'source', words: w.words, plural: w.plural }, { type: 'method', name: 'reduce' }, { type: 'property', name: proj.name, role: 'accumulate' });
    }
    valueType = 'number';
  }
  return { facts, valueType };
}

/** Collection an iteration runs over, looking through `.iter()` / `&` / `.values()`. */
function iterableWords(a: LangAdapter, over: SyntaxNode): { words: string[]; plural: boolean } | null {
  const chain = chainOf(a, over);
  if (!chain.calls.every((c) => COLLECT.has(c.method) || PRESERVING.has(c.method))) return null;
  return rootWords(a, chain.root);
}

const BLOCK_SCOPE = /^(block|compound_statement|declaration_list|statement_block|suite|match_block|source_file|module)$/;
const LOOP_SCOPE = /(for_expression|for_statement|enhanced_for_statement|foreach_statement|for_each_statement|for_in_clause|list_comprehension|dictionary_comprehension|set_comprehension|generator_expression)/;

/** The region of the function in which a declaration is visible. */
function scopeOf(a: LangAdapter, d: Decl, fn: SyntaxNode): SyntaxNode {
  if (d.kind === 'param') return fn;
  if (d.kind === 'closure') {
    for (let p: SyntaxNode | null = d.id.parent; p; p = p.parent) if (a.lambdaShape(p)) return p;
    return fn;
  }
  if (d.kind === 'loop') {
    for (let p: SyntaxNode | null = d.id.parent; p; p = p.parent) {
      // a comprehension variable is visible in the whole comprehension, not just in its `for ... in` clause
      if (p.type === 'for_in_clause') return p.parent ?? p;
      if (LOOP_SCOPE.test(p.type)) return p;
    }
    return fn;
  }
  if (a.id === 'python') return fn; // function-level scoping
  for (let p: SyntaxNode | null = d.id.parent; p && p.id !== fn.id; p = p.parent) if (BLOCK_SCOPE.test(p.type)) return p;
  return fn;
}

const within = (inner: SyntaxNode, outer: SyntaxNode) => inner.startIndex >= outer.startIndex && inner.endIndex <= outer.endIndex;

function argWords(a: LangAdapter, arg: SyntaxNode): { words: string[]; plural: boolean } | null {
  const root = chainOf(a, arg).root;
  if (a.identifierTypes.has(root.type)) return wordsOfIdentifierName(root.text);
  const m = a.member(root);
  return m ? wordsOfIdentifierName(m.name) : null;
}

function elementFactsForClosure(a: LangAdapter, d: Decl): Fact[] {
  // find the lambda this parameter belongs to
  let lam: SyntaxNode | null = d.id.parent;
  while (lam && !a.lambdaShape(lam)) lam = lam.parent;
  if (!lam) return [];
  const shape = a.lambdaShape(lam)!;
  if (!shape.params[0] || shape.params[0].id !== d.id.id) return [];
  // lambda is an argument of `<chain>.method(lambda)`
  let call: SyntaxNode | null = lam.parent;
  for (let k = 0; k < 3 && call && !a.callShape(call); k++) call = call.parent; // argument -> argument_list -> call
  const cs = call ? a.callShape(call) : null;
  if (!cs || !cs.object || !ITERATING.has(cs.method) || cs.args[0]?.id !== lam.id) return [];
  const before = chainOf(a, cs.object);
  if (!before.calls.every((c) => PRESERVING.has(c.method) || COLLECT.has(c.method))) return [];
  const w = rootWords(a, before.root);
  return w && w.plural ? [{ type: 'element-of', words: w.words, method: cs.method }] : [];
}

const VERBS = new Set(['get', 'load', 'fetch', 'build', 'create', 'make', 'compute', 'calculate', 'calc', 'render', 'init', 'handle', 'update', 'parse', 'read', 'save', 'process', 'show', 'hide', 'on', 'set', 'add', 'remove', 'find']);

/** One planned rename. */
interface Plan {
  decl: Decl;
  occurrences: SyntaxNode[];
  subject: NamingSubject;
  fnNode: SyntaxNode;
}

export interface RefactorOutput {
  edits: TextEdit[];
  changes: Change[];
  suggestions: Suggestion[];
  warnings: Warning[];
  /** old -> new identifier pairs, to prove that only these tokens changed. */
  renamedPairs: Set<string>;
}

export async function planRenames(args: {
  a: LangAdapter;
  root: SyntaxNode;
  source: string;
  file: string;
  config: Config;
  project: ProjectContext;
}): Promise<RefactorOutput> {
  const { a, root, source, file, config, project } = args;
  const out: RefactorOutput = { edits: [], changes: [], suggestions: [], warnings: [], renamedPairs: new Set() };
  const threshold = renameApplyThreshold(config);
  const abbreviations = new Set(project.naming.vocabulary.abbreviations.map((x) => x.abbreviation));
  const naming = { ...project.naming, convention: { ...project.naming.convention, casing: a.casing } };

  // identifier tokens of the whole file: a new name must not collide with any of them
  const fileNames = new Set<string>();
  const functions: SyntaxNode[] = [];
  const walkTop = (n: SyntaxNode, insideFn: boolean): void => {
    if (a.identifierTypes.has(n.type) && n.childCount === 0) fileNames.add(n.text);
    const isFn = a.functionTypes.has(n.type);
    if (isFn && !insideFn) functions.push(n);
    for (let i = 0; i < n.childCount; i++) walkTop(n.child(i)!, insideFn || isFn);
  };
  walkTop(root, false);

  const stem = (file.split('/').pop() ?? '').replace(/\.[^.]+$/, '');
  const introduced: { name: string; scope: SyntaxNode }[] = [];
  const lines = source.split('\n');

  for (const fn of functions) {
    const decls = a.decls(fn);
    // Same name declared several times is fine when the scopes are disjoint (two closures, two loops);
    // nested or equal scopes mean shadowing, which we do not try to untangle.
    const scopes = new Map<Decl, SyntaxNode>(decls.map((d) => [d, scopeOf(a, d, fn)]));
    const shadowed = new Set<string>();
    for (const d of decls) {
      for (const e of decls) {
        if (d === e || d.id.text !== e.id.text) continue;
        const sd = scopes.get(d)!;
        const se = scopes.get(e)!;
        if (within(sd, se) || within(se, sd)) shadowed.add(d.id.text);
      }
    }
    // every identifier-type leaf of the function by text
    const byText = new Map<string, SyntaxNode[]>();
    const strings: string[] = [];
    descend(fn, (n) => {
      if (n.childCount === 0 && a.identifierTypes.has(n.type)) {
        const list = byText.get(n.text) ?? [];
        list.push(n);
        byText.set(n.text, list);
      } else if (/string/.test(n.type) && n.childCount <= 1) strings.push(n.text);
    });
    const hasGlobalStmt = a.id === 'python' && /^\s*(global|nonlocal)\b/m.test(fn.text);
    const fnName = f(fn, 'name')?.text ?? '';
    const ctxWords = [...splitWords(stem), ...splitWords(fnName).filter((w) => !VERBS.has(w))].filter(Boolean).map(singularize);

    for (const d of decls) {
      const name = d.id.text;
      if (shadowed.has(name) || hasGlobalStmt) continue;
      const scope = scopes.get(d)!;
      if (!(isPoorName(name) || splitWords(name).some((w) => abbreviations.has(w)))) continue;
      const occ = (byText.get(name) ?? []).filter((o) => within(o, scope));
      if (occ.some((o) => a.ambiguous(o))) continue;
      if (occ.some((o) => o.startIndex < d.id.startIndex) && d.kind === 'local') continue; // used before the declaration: a different variable
      if (a.formatCaptures && strings.some((s) => new RegExp(`\\{\\s*${name}\\b`).test(s))) continue;
      // Safety net: every other use of this text in the function must belong to another, disjoint declaration.
      // Anything else means our idea of the scope is wrong, and the rename is skipped.
      const leftover = (byText.get(name) ?? []).filter((o) => !occ.includes(o));
      if (leftover.some((o) => !decls.some((e) => e !== d && e.id.text === name && within(o, scopes.get(e)!)))) continue;

      // ---- facts ----
      const facts: Fact[] = [];
      let valueType: ValueType = 'unknown';
      if (d.init) {
        const r = initFacts(a, d.init);
        facts.push(...r.facts);
        valueType = r.valueType;
      }
      if (d.kind === 'loop' && d.over) {
        const w = iterableWords(a, d.over);
        if (w) facts.push({ type: 'element-of', words: w.words, method: 'for…of' });
      }
      if (d.kind === 'closure') facts.push(...elementFactsForClosure(a, d));
      for (const o of occ) {
        const p = o.parent;
        if (!p) continue;
        const cs = a.callShape(p);
        if (cs?.object && cs.object.id === o.id && a.pushMethods.has(cs.method) && cs.args[0]) {
          const w = argWords(a, cs.args[0]);
          if (w) facts.push({ type: 'usage', kind: 'push', words: w.words, plural: w.plural });
          if (valueType === 'unknown') valueType = 'array';
        }
        // Go: x = append(x, item)
        if (a.id === 'go' && cs && !cs.object && cs.method === 'append' && cs.args[0]?.id === o.id && cs.args[1]) {
          const arg = unwrap(cs.args[1]);
          const w = a.identifierTypes.has(arg.type) ? wordsOfIdentifierName(arg.text) : null;
          if (w) facts.push({ type: 'usage', kind: 'push', words: w.words, plural: w.plural });
          if (valueType === 'unknown') valueType = 'array';
        }
        const mem = a.member(p);
        if (mem && mem.object.id === o.id) facts.push({ type: 'usage', kind: 'property', property: mem.name });
        let q: SyntaxNode | null = p;
        for (let k = 0; k < 2 && q; k++, q = q.parent) {
          if (/(compound_assignment|augmented_assignment|update_expression|postfix_unary|inc_dec|assignment_expression|assignment_statement)/.test(q.type) && /(\+\+|\+=)/.test(q.text)) {
            facts.push({ type: 'usage', kind: 'increment' });
            if (valueType === 'unknown') valueType = 'number';
            break;
          }
        }
      }
      if (ctxWords.length) facts.push({ type: 'context', words: ctxWords });
      const kind: NamingSubject['kind'] = d.kind === 'param' || d.kind === 'closure' ? 'parameter' : 'variable';
      // A name chosen for a disjoint scope (another closure / loop) can be reused here.
      const overlapping = introduced.filter((x) => within(x.scope, scope) || within(scope, x.scope)).map((x) => x.name);
      const taken = new Set([...fileNames, ...overlapping]);
      const subject: NamingSubject = { file, name, kind, valueType, facts, takenNames: taken };

      // ---- candidates ----
      let candidates = proposeNames(subject, naming);
      const top = candidates[0];
      if (project.advisor && (!top || top.confidence < config.thresholds.autoApply)) {
        try {
          const usages = occ.slice(0, 4).map((o) => snippet(lines[o.startPosition.row] ?? '', 160));
          const advice = await project.advisor.adviseName({
            file,
            kind,
            currentName: name,
            valueType,
            context: snippet(lines[d.id.startPosition.row] ?? '', 240),
            usages,
            enclosingFunction: fnName || undefined,
            candidates: candidates.filter((c) => c.usable).slice(0, 5).map((c) => ({ name: c.name, score: c.score, evidence: c.evidence })),
            vocabulary: project.naming.vocabulary.entries.slice(0, 25).map((e) => e.word),
            convention: project.conventionNote,
            language: project.language,
          });
          candidates = withProposal(applyAdvice(candidates, advice, config.thresholds), advice, subject, config.thresholds, config.namingWeights);
        } catch {
          /* the advisor never blocks local analysis */
        }
      }

      let applied = false;
      for (const c of candidates) {
        const needed = c.ai ? Math.min(threshold, config.aiApplyThreshold) : threshold;
        if (!c.usable || c.confidence < needed) continue;
        if (a.reserved.has(c.name) || !isValidIdentifier(c.name) || taken.has(c.name)) continue;
        for (const o of occ) out.edits.push({ start: o.startIndex, end: o.endIndex, text: c.name });
        out.renamedPairs.add(`${name}\u0000${c.name}`);
        introduced.push({ name: c.name, scope });
        applied = true;
        const cls = classifyConfidence(c.confidence, config.thresholds);
        out.changes.push({
          file, kind: 'rename', ruleId: 'rename-variable', level: cls === 'auto' ? 'safe' : 'cautious',
          description: `Renamed ${kind} "${name}" → "${c.name}"`, loc: loc(d.id), before: name, after: c.name, confidence: c.confidence,
        });
        out.suggestions.push({ file, kind: 'rename', message: `Applied rename ${name} → ${c.name}`, loc: loc(d.id), confidence: c.confidence, candidates: candidates.filter((x) => x.confidence >= config.thresholds.suggest).slice(0, 5), details: { applied: true } });
        break;
      }
      if (!applied) {
        const shown = candidates.filter((c) => c.confidence >= config.thresholds.suggest);
        if (shown.length) out.suggestions.push({ file, kind: 'rename', message: `Candidate names for ${kind} "${name}" (not applied)`, loc: loc(d.id), confidence: shown[0].confidence, candidates: shown.slice(0, 5), details: { applied: false, threshold } });
      }
    }
  }
  return out;
}

// ---- Language specific, behaviour-preserving rules ---------------------------------------------

export interface RuleEdit extends TextEdit {
  ruleId: string;
  description: string;
  line: number;
}

export const TS_RULES: Record<string, { id: string; description: string; level: 'safe' }[]> = {
  rust: [
    { id: 'rust-redundant-return', description: 'Removes `return x;` as the last statement of a function (the tail expression `x` is idiomatic)', level: 'safe' },
    { id: 'rust-bool-literal-comparison', description: '`x == true` -> `x`, `x == false` -> `!x` (typing guarantees x is a bool)', level: 'safe' },
    { id: 'rust-redundant-parens', description: 'Removes parentheses around `if` / `while` conditions and `let` values', level: 'safe' },
  ],
  java: [{ id: 'java-bool-literal-comparison', description: '`x == true` -> `x`, `x == false` -> `!x`', level: 'safe' }],
  go: [
    { id: 'go-bool-literal-comparison', description: '`x == true` -> `x`, `x == false` -> `!x`', level: 'safe' },
    { id: 'go-redundant-parens', description: '`if (x) {` -> `if x {`', level: 'safe' },
  ],
  python: [{ id: 'python-redundant-parens', description: '`if (x):` -> `if x:`', level: 'safe' }],
};

function hasType(n: SyntaxNode, type: string): boolean {
  let found = false;
  descend(n, (c) => {
    if (c.type === type) found = true;
  });
  return found;
}

const SIMPLE = /^(identifier|field_expression|call_expression|field_access|method_invocation|selector_expression|attribute|call|member_access_expression|invocation_expression|index_expression|parenthesized_expression)$/;

export function ruleEdits(langId: string, root: SyntaxNode, source: string): RuleEdit[] {
  const edits: RuleEdit[] = [];
  const claimed: [number, number][] = [];
  const free = (s: number, e: number) => !claimed.some(([a, b]) => s < b && e > a);
  const push = (n: SyntaxNode, text: string, ruleId: string, description: string, from = n.startIndex, to = n.endIndex) => {
    if (!free(from, to)) return;
    claimed.push([from, to]);
    edits.push({ start: from, end: to, text, ruleId, description, line: n.startPosition.row + 1 });
  };
  const boolEdit = (n: SyntaxNode, trueTypes: string[], ruleId: string) => {
    const l = f(n, 'left');
    const r = f(n, 'right');
    const op = f(n, 'operator')?.text ?? n.children.find((c) => !c.isNamed)?.text;
    if (!l || !r || (op !== '==' && op !== '!=')) return;
    const isLit = (x: SyntaxNode) => trueTypes.includes(x.type) && (x.text === 'true' || x.text === 'false');
    if (isLit(l) === isLit(r)) return;
    const lit = isLit(r) ? r : l;
    const other = isLit(r) ? l : r;
    const wantTrue = (lit.text === 'true') === (op === '==');
    const t = other.text;
    const text = wantTrue ? t : SIMPLE.test(other.type) && other.type !== 'parenthesized_expression' ? `!${t}` : `!(${t})`;
    // a comparison inside another comparison would need parentheses: leave those alone
    if (n.parent && /binary_expression|comparison_operator/.test(n.parent.type)) return;
    push(n, text, ruleId, `${n.text} -> ${text}`);
  };

  descend(root, (n) => {
    if (langId === 'rust') {
      if (n.type === 'function_item') {
        const body = f(n, 'body');
        const last = body?.namedChildren.filter((c) => !/comment/.test(c.type)).pop();
        const ret = last?.type === 'expression_statement' ? last.namedChildren[0] : null;
        if (ret?.type === 'return_expression' && body) {
          const value = ret.namedChildren[0];
          if (value) push(last!, value.text, 'rust-redundant-return', `return ${value.text.slice(0, 40)}; -> ${value.text.slice(0, 40)}`);
          else if (!f(n, 'return_type')) push(last!, '', 'rust-redundant-return', 'return; removed');
        }
      } else if (n.type === 'binary_expression') boolEdit(n, ['boolean_literal'], 'rust-bool-literal-comparison');
      else if (n.type === 'if_expression' || n.type === 'while_expression') {
        const c = f(n, 'condition');
        if (c?.type === 'parenthesized_expression' && !hasType(c, 'struct_expression')) {
          const inner = c.namedChildren[0];
          if (inner) push(c, inner.text, 'rust-redundant-parens', `(${inner.text.slice(0, 30)}) -> ${inner.text.slice(0, 30)}`);
        }
      } else if (n.type === 'let_declaration') {
        const v = f(n, 'value');
        if (v?.type === 'parenthesized_expression' && v.namedChildCount === 1 && v.namedChildren[0].type !== 'tuple_expression') push(v, v.namedChildren[0].text, 'rust-redundant-parens', 'redundant parentheses around a let value');
      }
    } else if (langId === 'java' && n.type === 'binary_expression') boolEdit(n, ['true', 'false'], 'java-bool-literal-comparison');
    else if (langId === 'go') {
      if (n.type === 'binary_expression') boolEdit(n, ['true', 'false'], 'go-bool-literal-comparison');
      else if (n.type === 'if_statement' || n.type === 'for_statement') {
        const c = f(n, 'condition');
        if (c?.type === 'parenthesized_expression' && c.namedChildCount === 1 && !c.text.includes('{')) push(c, c.namedChildren[0].text, 'go-redundant-parens', 'redundant parentheses around a condition');
      }
    } else if (langId === 'python' && (n.type === 'if_statement' || n.type === 'while_statement' || n.type === 'elif_clause')) {
      const c = f(n, 'condition');
      if (c?.type === 'parenthesized_expression' && c.namedChildCount === 1 && !/yield|:=/.test(c.text)) push(c, c.namedChildren[0].text, 'python-redundant-parens', 'redundant parentheses around a condition');
    }
  });
  return edits;
}
