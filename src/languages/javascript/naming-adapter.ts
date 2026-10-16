import * as t from '@babel/types';
import { basename } from '../../core/text.js';
import type { Fact, NamingSubject, ValueType } from '../../naming/facts.js';
import { isPoorName, singularize, splitWords } from '../../naming/words.js';
import { isBindingExported } from './semantic.js';
import { traverse, type Binding, type NodePath, type Scope } from './traverse.js';
import { ARRAY_ITERATORS, inferValue, wordsOfExpression } from './value-facts.js';

export interface RenameTarget {
  binding: Binding;
  subject: NamingSubject;
  loc: { line: number; column: number };
  enclosingFunction?: string;
  context?: string;
}

const VERB_PREFIX = new Set(['get', 'load', 'fetch', 'build', 'create', 'make', 'compute', 'calculate', 'render', 'init', 'handle', 'update', 'parse', 'read', 'save', 'process', 'show', 'hide', 'on', 'set', 'add', 'remove']);

function fileStemWords(file: string): string[] {
  const stem = basename(file).replace(/\.[^.]+$/, '');
  if (['index', 'main', 'app', 'script', 'utils', 'helpers', 'messy', 'common'].includes(stem.toLowerCase())) return [];
  return splitWords(stem);
}

function functionContextWords(path: NodePath): string[] {
  const fn = path.getFunctionParent();
  if (!fn) return [];
  let name: string | undefined;
  if (fn.isFunctionDeclaration() && fn.node.id) name = fn.node.id.name;
  else if (fn.parentPath.isVariableDeclarator() && t.isIdentifier(fn.parentPath.node.id)) name = fn.parentPath.node.id.name;
  if (!name) return [];
  const ws = splitWords(name).filter((w) => !VERB_PREFIX.has(w));
  return ws;
}

/** Whether a rename of this binding can be proven local. Conservative by design. */
export function isRenameable(binding: Binding, isModule: boolean, protectedNames: Set<string>, allowGlobal: (name: string) => boolean = () => false): boolean {
  const idNode = binding.identifier;
  if (!['var', 'let', 'const', 'param', 'hoisted'].includes(binding.kind)) return false;
  if (protectedNames.has(idNode.name)) return false;
  if (binding.kind === 'hoisted') {
    if (!binding.path.isFunctionDeclaration()) return false;
    if (binding.scope.path.isProgram() && !isModule && !allowGlobal(idNode.name)) return false;
    return !isBindingExported(binding);
  }
  // Only plain identifiers: destructuring keys / TS parameter properties are skipped.
  const bp = binding.path;
  if (binding.kind === 'param') {
    const fn = bp.parentPath;
    if (!bp.isIdentifier() && !(bp.isAssignmentPattern() && t.isIdentifier(bp.node.left))) return false;
    if (fn && fn.isClassMethod() && fn.node.kind === 'constructor' && bp.parentPath?.isTSParameterProperty()) return false;
    if (bp.parentPath?.isTSParameterProperty()) return false;
  } else {
    if (!bp.isVariableDeclarator() || !t.isIdentifier(bp.node.id)) return false;
    if (bp.parentPath.isVariableDeclaration() && (bp.parentPath.node.declare === true)) return false;
  }
  // classic-script globals are shared with other files unless the project proves they are private
  if (binding.scope.path.isProgram() && !isModule && !allowGlobal(idNode.name)) return false;
  if (isBindingExported(binding)) return false;
  // `window.x` / `globalThis.x` style access would bypass the scope analysis.
  return true;
}

/** Checks that `newName` cannot capture or be captured anywhere the binding is visible. */
export function conflictsWith(binding: Binding, newName: string, program: Scope): string | null {
  const scope = binding.scope;
  if (scope.hasBinding(newName)) return 'name already declared in an enclosing scope';
  if (program.globals[newName]) return 'name is used as a global in this file';
  let clash = false;
  scope.path.traverse({
    Scopable(p) {
      if (p.scope !== scope && p.scope.hasOwnBinding(newName)) clash = true;
    },
  });
  if (clash) return 'name declared in a nested scope';
  return null;
}

function collectionOfLoopDeclarator(path: NodePath): { words: string[]; plural: boolean } | null {
  const declaration = path.parentPath; // VariableDeclarator -> VariableDeclaration -> ForOfStatement
  const stmt = declaration?.parentPath;
  if (stmt?.isForOfStatement() && stmt.node.left === declaration?.node) {
    return wordsOfExpression(stmt.node.right);
  }
  return null;
}

/** `if (todo.done) res.push(todo)` -> "done": the collection is a hand-written filter on that property. */
function pushPredicate(call: NodePath<t.CallExpression>, arg: t.Node): string | undefined {
  if (!t.isIdentifier(arg)) return undefined;
  let p: NodePath | null = call.parentPath;
  while (p && !p.isFunction()) {
    if (p.isIfStatement()) {
      const test = p.node.test;
      let prop: string | undefined;
      const scan = (n: t.Node): void => {
        if (prop) return;
        if (t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.object, { name: arg.name }) && t.isIdentifier(n.property)) {
          prop = n.property.name;
          return;
        }
        for (const key of t.VISITOR_KEYS[n.type] ?? []) {
          const c = (n as unknown as Record<string, unknown>)[key];
          if (Array.isArray(c)) c.forEach((x) => x && scan(x as t.Node));
          else if (c) scan(c as t.Node);
        }
      };
      scan(test);
      if (prop) return prop;
    }
    p = p.parentPath;
  }
  return undefined;
}

const BUILD_VERBS = new Set(['add', 'create', 'make', 'build', 'new', 'init']);

/** `function addTodo() { var o = {}; ...; return o; }` -> o is a todo. */
function builtByFact(bp: NodePath, init: t.Node | null | undefined): Fact | null {
  if (!init || !(t.isObjectExpression(init) || t.isNewExpression(init))) return null;
  const fn = bp.getFunctionParent();
  let name: string | undefined;
  if (fn?.isFunctionDeclaration() && fn.node.id) name = fn.node.id.name;
  else if (fn?.parentPath.isVariableDeclarator() && t.isIdentifier(fn.parentPath.node.id)) name = fn.parentPath.node.id.name;
  if (!name) return null;
  const ws = splitWords(name);
  if (ws.length < 2 || !BUILD_VERBS.has(ws[0])) return null;
  return { type: 'builtBy', verb: ws[0], words: ws.slice(1) };
}

function usageFacts(binding: Binding): Fact[] {
  const facts: Fact[] = [];
  for (const ref of binding.referencePaths) {
    const parent = ref.parentPath;
    if (!parent) continue;
    if (parent.isMemberExpression() && parent.node.object === ref.node && !parent.node.computed && t.isIdentifier(parent.node.property)) {
      const prop = parent.node.property.name;
      const call = parent.parentPath;
      if (prop === 'push' && call?.isCallExpression() && call.node.callee === parent.node && call.node.arguments.length >= 1) {
        const w = wordsOfExpression(call.node.arguments[0] as t.Node);
        if (w) facts.push({ type: 'usage', kind: 'push', words: w.words, plural: w.plural, predicate: pushPredicate(call, call.node.arguments[0] as t.Node) });
      } else if (prop === 'addEventListener' && call?.isCallExpression()) {
        const ev = call.node.arguments[0];
        if (t.isStringLiteral(ev, { value: 'click' })) facts.push({ type: 'usage', kind: 'click' });
      } else if (prop === 'onclick') facts.push({ type: 'usage', kind: 'click' });
      else if (call?.isCallExpression() && call.node.callee === parent.node) {
        /* method call on the value */
      } else facts.push({ type: 'usage', kind: 'property', property: prop });
    } else if (parent.isReturnStatement()) {
      facts.push({ type: 'usage', kind: 'returned' });
    } else if (parent.isAssignmentExpression() && parent.node.right === ref.node && t.isMemberExpression(parent.node.left) && t.isIdentifier(parent.node.left.property) && !parent.node.left.computed) {
      facts.push({ type: 'usage', kind: 'sink', property: parent.node.left.property.name });
    } else if (parent.isAssignmentExpression() && parent.node.left === ref.node) {
      if (parent.node.operator === '+=') {
        const r = parent.node.right;
        if (t.isNumericLiteral(r)) facts.push({ type: 'usage', kind: 'increment' });
        else if (t.isMemberExpression(r) && !r.computed && t.isIdentifier(r.property)) facts.push({ type: 'usage', kind: 'accumulate', property: r.property.name });
        else facts.push({ type: 'usage', kind: 'accumulate' });
      }
    } else if (parent.isUpdateExpression()) {
      facts.push({ type: 'usage', kind: 'increment' });
    } else if ((parent.isIfStatement() || parent.isConditionalExpression()) && (parent.node as t.IfStatement).test === ref.node) {
      facts.push({ type: 'usage', kind: 'boolean-test' });
    }
  }
  // `x = x + obj.prop`
  return facts;
}

function callSiteFacts(paramIndex: number, fn: NodePath<t.Function>, allowGlobal: (name: string) => boolean): Fact | null {
  // The function must be a local binding, never exported and only ever called directly.
  let fnBinding: Binding | undefined;
  if (fn.isFunctionDeclaration() && fn.node.id) fnBinding = fn.scope.parent?.getBinding(fn.node.id.name);
  else if (fn.parentPath.isVariableDeclarator() && t.isIdentifier(fn.parentPath.node.id)) fnBinding = fn.scope.parent?.getBinding(fn.parentPath.node.id.name) ?? fn.scope.getBinding(fn.parentPath.node.id.name);
  if (!fnBinding || isBindingExported(fnBinding)) return null;
  if (fnBinding.scope.path.isProgram() && !(fnBinding.scope.path.node as t.Program).sourceType.startsWith('module') && !allowGlobal(fnBinding.identifier.name)) return null; // global function: other code may call it
  if (fnBinding.constantViolations.length) return null;
  const sites = fnBinding.referencePaths;
  if (!sites.length) return null;
  let words: string[] | null = null;
  let plural = false;
  for (const ref of sites) {
    const call = ref.parentPath;
    if (!call?.isCallExpression() || call.node.callee !== ref.node) return null; // escapes as a value
    const arg = call.node.arguments[paramIndex];
    if (!arg || t.isSpreadElement(arg)) return null;
    const w = wordsOfExpression(arg);
    if (!w) return null;
    const key = w.words.join(' ');
    if (words && words.join(' ') !== key) return null;
    words = w.words;
    plural = w.plural;
  }
  return words ? { type: 'callsite', words, plural, count: sites.length } : null;
}

/**
 * Finds poorly named bindings and describes them as language-neutral NamingSubjects.
 * Does not modify the AST.
 */
export function collectRenameTargets(
  ast: t.File,
  file: string,
  opts: { protectedNames: Set<string>; isCandidateName: (name: string) => boolean; allowGlobal: (name: string) => boolean },
): RenameTarget[] {
  const targets: RenameTarget[] = [];
  const program = ast.program;
  const isModule = program.sourceType === 'module';
  const seen = new Set<Scope>();
  let programScope: Scope | undefined;

  if (hasDynamicScope(ast)) return targets;

  traverse(ast, {
    Program(p) {
      programScope = p.scope;
    },
    Scopable(path) {
      if (seen.has(path.scope)) return;
      seen.add(path.scope);
      for (const [name, binding] of Object.entries(path.scope.bindings)) {
        if (!binding) continue;
        if (!opts.isCandidateName(name) && !isPoorName(name)) continue;
        if (!isRenameable(binding, isModule, opts.protectedNames, opts.allowGlobal)) continue;
        const bp = binding.path;
        const facts: Fact[] = [];
        let valueType: ValueType = 'unknown';
        let kind: NamingSubject['kind'] = binding.kind === 'param' ? 'parameter' : 'variable';
        const fnPath = functionOf(binding);
        if (fnPath) {
          kind = 'function';
          valueType = 'function';
          facts.push(...functionFacts(fnPath, binding));
        }

        if (bp.isVariableDeclarator() && !fnPath) {
          const info = inferValue(bp.node.init ?? null, bp.scope);
          valueType = info.valueType;
          facts.push(...info.facts);
          // for (const s of stations)
          const loop = collectionOfLoopDeclarator(bp);
          if (loop) facts.push({ type: 'element-of', words: loop.words, method: 'for…of' });
          // let x = []; ... x.push(station)
          if (bp.node.init && t.isArrayExpression(bp.node.init)) valueType = 'array';
          const built = builtByFact(bp, bp.node.init);
          if (built) facts.push(built);
        } else if (binding.kind === 'param') {
          const fn = bp.parentPath;
          const paramPath = bp;
          if (fn?.isFunction()) {
            const idx = (fn.node.params as t.Node[]).indexOf(paramPath.node);
            const call = fn.parentPath;
            // Callback of an array iteration: stations.map(s => ...)
            if (call?.isCallExpression() && call.node.arguments[0] === fn.node && t.isMemberExpression(call.node.callee) && t.isIdentifier(call.node.callee.property)) {
              const method = call.node.callee.property.name;
              if (ARRAY_ITERATORS.has(method)) {
                const elementIndex = method === 'reduce' ? 1 : 0;
                if (idx === elementIndex) {
                  const w = wordsOfExpression(call.node.callee.object);
                  if (w && w.plural) {
                    facts.push({ type: 'element-of', words: w.words, method });
                    valueType = 'object';
                  }
                }
              }
            } else if (idx >= 0) {
              const alt = callSiteFacts(idx, fn as NodePath<t.Function>, opts.allowGlobal);
              if (alt) facts.push(alt);
            }
          }
        }
        facts.push(...usageFacts(binding));
        if (facts.some((f) => f.type === 'usage' && f.kind === 'push') && valueType === 'unknown') valueType = 'array';
        if (facts.some((f) => f.type === 'usage' && f.kind === 'accumulate' || f.type === 'usage' && f.kind === 'increment') && valueType === 'unknown' && bp.isVariableDeclarator() && t.isNumericLiteral(bp.node.init)) valueType = 'number';

        const ctxWords = [...fileStemWords(file), ...functionContextWords(bp)];
        if (ctxWords.length) facts.push({ type: 'context', words: ctxWords.map(singularize) });

        // Names that would collide with this one: everything bound in or above the scope.
        const taken = new Set<string>();
        let s: Scope | null = binding.scope;
        while (s) {
          Object.keys(s.bindings).forEach((n) => taken.add(n));
          s = s.parent;
        }
        targets.push({
          binding,
          subject: { file, name, kind, valueType, facts, takenNames: taken },
          loc: { line: binding.identifier.loc?.start.line ?? 0, column: (binding.identifier.loc?.start.column ?? 0) + 1 },
          enclosingFunction: undefined,
        });
      }
    },
  });
  void programScope;
  return targets;
}

/** The function a binding names: `function f(){}` or `const f = () => {}`. */
function functionOf(binding: Binding): NodePath<t.Function> | null {
  const bp = binding.path;
  if (bp.isFunctionDeclaration()) return bp as NodePath<t.Function>;
  if (bp.isVariableDeclarator()) {
    const init = bp.get('init');
    if (!Array.isArray(init) && init.node && (init.isArrowFunctionExpression() || init.isFunctionExpression())) return init as NodePath<t.Function>;
  }
  return null;
}

function domTargetWords(node: t.Node | null | undefined, scope: Scope): string[] | null {
  if (!node) return null;
  let expr: t.Node | null | undefined = node;
  if (t.isIdentifier(expr)) {
    const b = scope.getBinding(expr.name);
    expr = b?.path.isVariableDeclarator() ? b.path.node.init : null;
  }
  const info = inferValue(expr, scope);
  const dom = info.facts.find((f) => f.type === 'dom');
  if (!dom || dom.type !== 'dom') return null;
  return splitWords(dom.value.replace(/^[.#]/, ''));
}

/** What the surrounding code says about a function: where it is registered as a handler, what it renders, what it returns. */
function functionFacts(fn: NodePath<t.Function>, binding: Binding): Fact[] {
  const facts: Fact[] = [];
  // event wiring: el.addEventListener('click', fn) / el.onclick = fn
  for (const ref of binding.referencePaths) {
    const p = ref.parentPath;
    if (p?.isCallExpression() && t.isMemberExpression(p.node.callee) && t.isIdentifier(p.node.callee.property, { name: 'addEventListener' }) && p.node.arguments[1] === ref.node && t.isStringLiteral(p.node.arguments[0])) {
      const words = domTargetWords(p.node.callee.object, p.scope);
      facts.push({ type: 'handler', event: p.node.arguments[0].value, targetWords: words ?? [] });
      break;
    }
    if (p?.isAssignmentExpression() && p.node.right === ref.node && t.isMemberExpression(p.node.left) && t.isIdentifier(p.node.left.property) && /^on[a-z]+$/.test(p.node.left.property.name)) {
      const words = domTargetWords(p.node.left.object, p.scope);
      facts.push({ type: 'handler', event: p.node.left.property.name.slice(2), targetWords: words ?? [] });
      break;
    }
  }
  // rendering: el.innerHTML = ...
  let renders: string[] | null = null;
  fn.traverse({
    AssignmentExpression(a) {
      const l = a.node.left;
      if (renders || !t.isMemberExpression(l) || !t.isIdentifier(l.property) || !['innerHTML', 'textContent', 'innerText', 'outerHTML'].includes(l.property.name)) return;
      renders = domTargetWords(l.object, a.scope);
    },
  });
  if (renders && (renders as string[]).length) facts.push({ type: 'renders', words: renders });
  // what it returns
  const body = fn.node.body;
  let ret: t.Node | null | undefined = null;
  if (!t.isBlockStatement(body)) ret = body;
  else {
    const last = body.body[body.body.length - 1];
    if (last && t.isReturnStatement(last)) ret = last.argument;
  }
  if (ret) {
    const info = inferValue(ret, fn.scope);
    facts.push(...info.facts.filter((f) => f.type === 'source' || f.type === 'method' || f.type === 'property'));
  }
  return facts;
}

export function hasDynamicScope(ast: t.File): boolean {
  let dynamic = false;
  traverse(ast, {
    WithStatement() {
      dynamic = true;
    },
    CallExpression(p) {
      if (t.isIdentifier(p.node.callee, { name: 'eval' }) || t.isIdentifier(p.node.callee, { name: 'Function' })) dynamic = true;
    },
    NewExpression(p) {
      if (t.isIdentifier(p.node.callee, { name: 'Function' })) dynamic = true;
    },
  });
  return dynamic;
}
