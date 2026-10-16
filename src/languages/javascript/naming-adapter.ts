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
export function isRenameable(binding: Binding, isModule: boolean, protectedNames: Set<string>): boolean {
  const idNode = binding.identifier;
  if (!['var', 'let', 'const', 'param'].includes(binding.kind)) return false;
  if (protectedNames.has(idNode.name)) return false;
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
  if (binding.scope.path.isProgram() && !isModule) return false; // classic-script globals are shared with other files
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
  const decl = path.parentPath; // VariableDeclarator -> VariableDeclaration -> ForOfStatement
  const stmt = decl?.parentPath?.parentPath;
  if (stmt?.isForOfStatement() && stmt.node.left === decl?.parentPath?.node) {
    return wordsOfExpression(stmt.node.right);
  }
  return null;
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
        if (w) facts.push({ type: 'usage', kind: 'push', words: w.words, plural: w.plural });
      } else if (prop === 'addEventListener' && call?.isCallExpression()) {
        const ev = call.node.arguments[0];
        if (t.isStringLiteral(ev, { value: 'click' })) facts.push({ type: 'usage', kind: 'click' });
      } else if (prop === 'onclick') facts.push({ type: 'usage', kind: 'click' });
      else if (call?.isCallExpression() && call.node.callee === parent.node) {
        /* method call on the value */
      } else facts.push({ type: 'usage', kind: 'property', property: prop });
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

function callSiteFacts(paramIndex: number, fn: NodePath<t.Function>): Fact | null {
  // The function must be a local binding, never exported and only ever called directly.
  let fnBinding: Binding | undefined;
  if (fn.isFunctionDeclaration() && fn.node.id) fnBinding = fn.scope.parent?.getBinding(fn.node.id.name);
  else if (fn.parentPath.isVariableDeclarator() && t.isIdentifier(fn.parentPath.node.id)) fnBinding = fn.scope.parent?.getBinding(fn.parentPath.node.id.name) ?? fn.scope.getBinding(fn.parentPath.node.id.name);
  if (!fnBinding || isBindingExported(fnBinding)) return null;
  if (fnBinding.scope.path.isProgram() && !(fnBinding.scope.path.node as t.Program).sourceType.startsWith('module')) return null; // global function: HTML may call it
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
  opts: { protectedNames: Set<string>; isCandidateName: (name: string) => boolean },
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
        if (!isRenameable(binding, isModule, opts.protectedNames)) continue;
        const bp = binding.path;
        const facts: Fact[] = [];
        let valueType: ValueType = 'unknown';
        const kind: NamingSubject['kind'] = binding.kind === 'param' ? 'parameter' : 'variable';

        if (bp.isVariableDeclarator()) {
          const info = inferValue(bp.node.init ?? null, bp.scope);
          valueType = info.valueType;
          facts.push(...info.facts);
          // for (const s of stations)
          const loop = collectionOfLoopDeclarator(bp);
          if (loop) facts.push({ type: 'element-of', words: loop.words, method: 'for…of' });
          // let x = []; ... x.push(station)
          if (bp.node.init && t.isArrayExpression(bp.node.init)) valueType = 'array';
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
              const alt = callSiteFacts(idx, fn as NodePath<t.Function>);
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
