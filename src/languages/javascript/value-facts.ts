import * as t from '@babel/types';
import type { Fact, ValueType } from '../../naming/facts.js';
import { isPoorName, looksPlural, singularize, splitWords } from '../../naming/words.js';
import type { NodePath, Scope } from './traverse.js';

export interface ValueInfo {
  valueType: ValueType;
  facts: Fact[];
  /** Names of variables / external names the value derives from. */
  sources: string[];
  /** Label of the last operation, e.g. "filter". */
  via?: string;
}

export const ARRAY_ITERATORS = new Set(['forEach', 'map', 'filter', 'find', 'findIndex', 'findLast', 'some', 'every', 'reduce', 'flatMap']);
const ARRAY_RETURNING = new Set(['filter', 'map', 'slice', 'sort', 'concat', 'reverse', 'flat', 'flatMap', 'splice', 'toSorted', 'toReversed', 'fill']);
const ARRAY_ITEM_RETURNING = new Set(['find', 'findLast', 'pop', 'shift', 'at']);
const COMPARE_OPS = new Set(['==', '===', '!=', '!==', '<', '<=', '>', '>=', 'instanceof', 'in']);

/** Words describing what an expression is called: `this.stations` -> station(s). */
export function wordsOfExpression(node: t.Node | null | undefined): { words: string[]; plural: boolean } | null {
  if (!node) return null;
  let name: string | undefined;
  if (t.isIdentifier(node)) name = node.name;
  else if (t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.property)) name = node.property.name;
  else if (t.isTSNonNullExpression(node) || t.isTSAsExpression(node)) return wordsOfExpression(node.expression);
  else if (t.isAwaitExpression(node)) return wordsOfExpression(node.argument);
  else if (t.isCallExpression(node) && t.isMemberExpression(node.callee)) {
    // keep naming of the chain root: stations.filter(...).map(...) -> stations
    return wordsOfExpression(node.callee.object);
  }
  if (!name) return null;
  return wordsOfIdentifierName(name);
}

/** `stationList` -> station (plural), `activeStations` -> active station (plural): the noun phrase a name stands for. */
export function wordsOfIdentifierName(name: string): { words: string[]; plural: boolean } | null {
  if (isPoorName(name)) return null;
  const ws = splitWords(name);
  if (!ws.length) return null;
  // Strip generic collection suffixes: stationList -> station(s)
  const last = ws[ws.length - 1];
  if (ws.length > 1 && ['list', 'array', 'items', 'data', 'collection', 'set', 'map'].includes(last)) {
    return { words: ws.slice(0, -1).map((w, i, a) => (i === a.length - 1 ? singularize(w) : w)), plural: true };
  }
  // Japanese (and other non-ASCII) names carry no plural marker: treat them as possible collections.
  const nonAscii = /[^\u0000-\u007f]/.test(last);
  const plural = looksPlural(last) || nonAscii;
  return { words: [...ws.slice(0, -1), plural && !nonAscii ? singularize(last) : last], plural };
}

function literalString(node: t.Node | undefined | null): string | undefined {
  if (!node) return undefined;
  if (t.isStringLiteral(node)) return node.value;
  if (t.isTemplateLiteral(node) && node.expressions.length === 0) return node.quasis[0].value.cooked ?? undefined;
  return undefined;
}

function calleeName(callee: t.Node): string | undefined {
  if (t.isIdentifier(callee)) return callee.name;
  if (t.isMemberExpression(callee) && !callee.computed && t.isIdentifier(callee.property)) {
    const obj = t.isIdentifier(callee.object) ? callee.object.name : undefined;
    return obj ? `${obj}.${callee.property.name}` : callee.property.name;
  }
  return undefined;
}

function unwrap(node: t.Node): t.Node {
  let n = node;
  for (;;) {
    if (t.isAwaitExpression(n)) n = n.argument;
    else if (t.isParenthesizedExpression(n)) n = n.expression;
    else if (t.isTSAsExpression(n) || t.isTSNonNullExpression(n) || t.isTSTypeAssertion(n) || t.isTypeCastExpression(n)) n = n.expression;
    else return n;
  }
}

export function isBooleanExpression(node: t.Node): boolean {
  const n = unwrap(node);
  if (t.isBooleanLiteral(n)) return true;
  if (t.isUnaryExpression(n)) return n.operator === '!';
  if (t.isBinaryExpression(n)) return COMPARE_OPS.has(n.operator);
  if (t.isLogicalExpression(n)) return n.operator !== '??' && isBooleanExpression(n.left) && isBooleanExpression(n.right);
  if (t.isCallExpression(n) && t.isIdentifier(n.callee, { name: 'Boolean' })) return true;
  if (t.isCallExpression(n) && t.isMemberExpression(n.callee) && t.isIdentifier(n.callee.property)) {
    return ['includes', 'some', 'every', 'has', 'startsWith', 'endsWith', 'test', 'isArray', 'isInteger', 'isFinite', 'isNaN', 'hasOwnProperty'].includes(n.callee.property.name) && !t.isIdentifier(n.callee.object, { name: 'Math' });
  }
  return false;
}

/** Collects `param.prop` reads in a callback body. */
function propertyFacts(callback: t.Node, method: string): Fact[] {
  if (!(t.isArrowFunctionExpression(callback) || t.isFunctionExpression(callback))) return [];
  const paramIndex = method === 'reduce' ? 1 : 0;
  const accIndex = method === 'reduce' ? 0 : -1;
  const p = callback.params[paramIndex];
  const acc = accIndex >= 0 ? callback.params[accIndex] : undefined;
  if (!p || !t.isIdentifier(p)) return [];
  const pname = p.name;
  const facts: Fact[] = [];
  const seen = new Set<string>();

  const bodyExpr: t.Node | undefined = t.isBlockStatement(callback.body)
    ? (callback.body.body.length === 1 && t.isReturnStatement(callback.body.body[0]) ? callback.body.body[0].argument ?? undefined : undefined)
    : callback.body;

  const visit = (node: t.Node, parent: t.Node | null): void => {
    if (t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.object, { name: pname }) && t.isIdentifier(node.property)) {
      const prop = node.property.name;
      if (!seen.has(prop)) {
        seen.add(prop);
        if (method === 'filter' || method === 'find' || method === 'findIndex' || method === 'some' || method === 'every' || method === 'findLast') {
          let literal: string | undefined;
          if (parent && t.isBinaryExpression(parent) && (parent.operator === '===' || parent.operator === '==')) {
            literal = literalString(parent.left === node ? parent.right : parent.left);
          }
          facts.push({ type: 'property', name: prop, role: 'predicate', literal });
        } else if (method === 'map' || method === 'flatMap') {
          if (bodyExpr === node) facts.push({ type: 'property', name: prop, role: 'projection' });
        } else if (method === 'reduce' && acc && t.isIdentifier(acc)) {
          if (parent && t.isBinaryExpression(parent, { operator: '+' }) && ((t.isIdentifier(parent.left, { name: acc.name }) && parent.right === node) || (t.isIdentifier(parent.right, { name: acc.name }) && parent.left === node))) {
            facts.push({ type: 'property', name: prop, role: 'accumulate' });
          }
        }
      }
    }
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) child.forEach((c) => c && visit(c as t.Node, node));
      else if (child) visit(child as t.Node, node);
    }
  };
  visit(callback.body, null);
  // `acc + p.price` written as `acc += p.price`
  if (method === 'reduce' && acc && t.isIdentifier(acc) && !facts.length) {
    const visit2 = (node: t.Node): void => {
      if (t.isAssignmentExpression(node, { operator: '+=' }) && t.isMemberExpression(node.right) && t.isIdentifier(node.right.object, { name: pname }) && t.isIdentifier(node.right.property)) {
        facts.push({ type: 'property', name: node.right.property.name, role: 'accumulate' });
      }
      for (const key of t.VISITOR_KEYS[node.type] ?? []) {
        const child = (node as unknown as Record<string, unknown>)[key];
        if (Array.isArray(child)) child.forEach((c) => c && visit2(c as t.Node));
        else if (child) visit2(child as t.Node);
      }
    };
    visit2(callback.body);
  }
  return facts;
}

function resolveSourceName(node: t.Node, scope: Scope | undefined): string | undefined {
  const root = rootIdentifier(node);
  if (!root) return undefined;
  const b = scope?.getBinding(root.name);
  return b ? `${root.name}` : `global:${root.name}`;
}

export function rootIdentifier(node: t.Node): t.Identifier | undefined {
  let n: t.Node = unwrap(node);
  for (;;) {
    if (t.isIdentifier(n)) return n;
    if (t.isMemberExpression(n)) n = unwrap(n.object);
    else if (t.isCallExpression(n)) n = unwrap(n.callee);
    else if (t.isThisExpression(n)) return undefined;
    else return undefined;
  }
}

/**
 * Infers what an initializer expression is and which facts the naming engine may use.
 * Deliberately shallow and conservative: unknown stays unknown.
 */
export function inferValue(expr: t.Node | null | undefined, scope?: Scope): ValueInfo {
  const info: ValueInfo = { valueType: 'unknown', facts: [], sources: [] };
  if (!expr) return info;
  const node = unwrap(expr);
  const awaited = t.isAwaitExpression(expr);

  if (t.isArrayExpression(node)) return { ...info, valueType: 'array' };
  if (t.isObjectExpression(node)) return { ...info, valueType: 'object' };
  if (t.isStringLiteral(node) || t.isTemplateLiteral(node)) return { ...info, valueType: 'string' };
  if (t.isNumericLiteral(node)) return { ...info, valueType: 'number' };
  if (t.isBooleanLiteral(node)) return { ...info, valueType: 'boolean' };
  if (t.isRegExpLiteral(node)) return { ...info, valueType: 'regexp' };
  if (t.isArrowFunctionExpression(node) || t.isFunctionExpression(node)) return { ...info, valueType: 'function' };
  if (isBooleanExpression(node)) return { ...info, valueType: 'boolean' };
  if (t.isBinaryExpression(node) && ['-', '*', '/', '%', '**', '|', '&', '^', '<<', '>>'].includes(node.operator)) return { ...info, valueType: 'number' };
  if (t.isUpdateExpression(node)) return { ...info, valueType: 'number' };

  if (t.isNewExpression(node) && t.isIdentifier(node.callee)) {
    const n = node.callee.name;
    const vt: ValueType = n === 'Map' ? 'map' : n === 'Set' ? 'set' : n === 'Array' ? 'array' : n === 'RegExp' ? 'regexp' : n === 'Promise' ? 'promise' : 'object';
    return { ...info, valueType: vt };
  }

  if (t.isIdentifier(node)) {
    const src = resolveSourceName(node, scope);
    return { ...info, sources: src ? [src] : [] };
  }

  // document.getElementById('input').value  ->  the element's property
  if (t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.property) && ['value', 'textContent', 'innerText', 'checked', 'innerHTML'].includes(node.property.name)) {
    const inner = inferValue(node.object, scope);
    const dom = inner.facts.find((f) => f.type === 'dom');
    if (dom) {
      const p = node.property.name;
      return { valueType: p === 'checked' ? 'boolean' : 'string', facts: [dom, { type: 'property', name: p, role: 'read' }], sources: [], via: 'dom' };
    }
  }

  // `x.length`
  if (t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.property, { name: 'length' })) {
    const w = wordsOfExpression(node.object);
    const facts: Fact[] = w ? [{ type: 'source', words: w.words, plural: w.plural }, { type: 'method', name: 'length' }] : [];
    const s = resolveSourceName(node.object, scope);
    return { valueType: 'number', facts, sources: s ? [s] : [], via: 'length' };
  }

  if (t.isCallExpression(node)) {
    const callee = node.callee;
    const cname = calleeName(callee);

    // Static / well-known calls.
    if (cname) {
      if (/^Math\./.test(cname) || ['parseInt', 'parseFloat', 'Number'].includes(cname)) return { ...info, valueType: 'number' };
      if (cname === 'String') return { ...info, valueType: 'string' };
      if (cname === 'Boolean') return { ...info, valueType: 'boolean' };
      if (cname === 'fetch') {
        const arg = literalString(node.arguments[0]);
        const argWords = arg ? splitWords(arg.replace(/^https?:\/\/[^/]+/, '').split(/[?#]/)[0].split('/').filter(Boolean).slice(-1)[0] ?? '') : [];
        return { valueType: 'promise', facts: [{ type: 'call', callee: 'fetch', arg, argWords: argWords.length ? argWords : undefined }], sources: [], via: 'fetch' };
      }
      if (cname === 'JSON.parse') {
        const w = wordsOfExpression(node.arguments[0] as t.Node);
        const s = node.arguments[0] ? resolveSourceName(node.arguments[0] as t.Node, scope) : undefined;
        return { valueType: 'unknown', facts: [{ type: 'call', callee: 'JSON.parse', argWords: w?.words }, ...(w ? [{ type: 'source', words: w.words, plural: w.plural } as Fact, { type: 'method', name: 'parse' } as Fact] : [])], sources: s ? [s] : [], via: 'parse' };
      }
      if (/^Object\.(keys|values|entries)$/.test(cname) || cname === 'Array.from') {
        const m = cname.split('.')[1];
        const w = wordsOfExpression(node.arguments[0] as t.Node);
        const s = node.arguments[0] ? resolveSourceName(node.arguments[0] as t.Node, scope) : undefined;
        return { valueType: 'array', facts: w && m !== 'from' ? [{ type: 'source', words: w.words, plural: w.plural }, { type: 'method', name: m }] : [], sources: s ? [s] : [], via: m };
      }
      const domQuery: Record<string, 'id' | 'selector' | 'selectorAll' | 'class' | 'classAll' | 'tag'> = {
        'document.getElementById': 'id',
        'document.querySelector': 'selector',
        'document.querySelectorAll': 'selectorAll',
        'document.getElementsByClassName': 'classAll',
        'document.getElementsByTagName': 'tag',
      };
      const q = domQuery[cname] ?? (t.isMemberExpression(callee) && !callee.computed && t.isIdentifier(callee.property) ? domQuery['document.' + callee.property.name] : undefined);
      if (q) {
        const v = literalString(node.arguments[0]);
        if (v) {
          const many = q === 'selectorAll' || q === 'classAll' || q === 'tag';
          return { valueType: many ? 'elements' : 'element', facts: [{ type: 'dom', query: q, value: v }], sources: [], via: 'dom' };
        }
        return { ...info, valueType: q === 'selectorAll' || q === 'classAll' || q === 'tag' ? 'elements' : 'element' };
      }
    }

    // obj.method(...)
    if (t.isMemberExpression(callee) && !callee.computed && t.isIdentifier(callee.property)) {
      const method = callee.property.name;
      let obj: t.Node = unwrap(callee.object);
      // Walk through chained calls to find the origin and keep the *last* method.
      const chain: string[] = [];
      let origin: t.Node = obj;
      while (t.isCallExpression(origin) && t.isMemberExpression(origin.callee)) {
        const m = origin.callee.property;
        if (t.isIdentifier(m)) chain.push(m.name);
        origin = unwrap(origin.callee.object);
      }
      obj = origin;
      const w = wordsOfExpression(obj);
      const s = resolveSourceName(obj, scope);
      const facts: Fact[] = [];
      if (w) {
        facts.push({ type: 'source', words: w.words, plural: w.plural }, { type: 'method', name: method });
      }
      const cb = node.arguments[0];
      if (cb && w && ARRAY_ITERATORS.has(method)) facts.push(...propertyFacts(cb, method));
      let valueType: ValueType = 'unknown';
      if (ARRAY_RETURNING.has(method)) valueType = 'array';
      else if (ARRAY_ITEM_RETURNING.has(method)) valueType = 'unknown';
      else if (['findIndex', 'indexOf', 'lastIndexOf'].includes(method)) valueType = 'number';
      else if (['some', 'every', 'includes', 'startsWith', 'endsWith', 'has'].includes(method)) valueType = 'boolean';
      else if (['join', 'trim', 'toLowerCase', 'toUpperCase', 'replace', 'toString', 'padStart', 'padEnd'].includes(method)) valueType = 'string';
      else if (['split'].includes(method)) valueType = 'array';
      else if (method === 'json' || method === 'text') valueType = 'unknown';
      // Only trust "this is a collection" when the source reads like one.
      if (valueType === 'array' && w && !w.plural && !['split', 'concat'].includes(method)) {
        // `x.map` on a singular-looking name: keep the type, but weaken facts to avoid wrong nouns.
        facts.length = 0;
      }
      return { valueType, facts, sources: s ? [s] : [], via: method };
    }
  }

  // foo(...): keep the callee's name, `calcTotal()` -> total
  if (t.isCallExpression(node) && t.isIdentifier(node.callee)) {
    const b = scope?.getBinding(node.callee.name);
    const isLocalFn = !!b && (b.path.isFunction() || (b.path.isVariableDeclarator() && !!b.path.node.init && t.isFunction(b.path.node.init)));
    if (isLocalFn || !b) return { ...info, facts: [{ type: 'call', callee: node.callee.name }], via: 'call' };
  }
  if (t.isCallExpression(node) || t.isNewExpression(node) || awaited) return info;
  return info;
}

export function isAssignedFunction(path: NodePath): boolean {
  return path.isFunction();
}
