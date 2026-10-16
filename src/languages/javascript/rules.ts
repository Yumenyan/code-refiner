import * as t from '@babel/types';
import type { Rule, RuleHit } from '../../core/rule-engine.js';
import { snippet } from '../../core/text.js';
import { isBindingExported } from './semantic.js';
import { traverse, type NodePath } from './traverse.js';
import { isBooleanExpression } from './value-facts.js';

export interface EcmaRuleContext {
  source: string;
  file: string;
  isModule: boolean;
  removeUnused: boolean;
  hasJsx: boolean;
  language: 'javascript' | 'typescript';
}

export type EcmaRule = Rule<t.File, EcmaRuleContext>;

const loc = (n: t.Node) => ({ line: n.loc?.start.line ?? 0, column: (n.loc?.start.column ?? 0) + 1 });
const text = (ctx: EcmaRuleContext, n: t.Node) => (n.start != null && n.end != null ? snippet(ctx.source.slice(n.start, n.end), 100) : undefined);
const hasComments = (n: t.Node) => !!(n.leadingComments?.length || n.trailingComments?.length || n.innerComments?.length);

// ---------------------------------------------------------------------------------------------

function boolLiteralOf(node: t.Node | null | undefined): boolean | null {
  if (!node) return null;
  if (t.isBooleanLiteral(node)) return node.value;
  if (t.isBlockStatement(node) && node.body.length === 1) return boolLiteralOf(node.body[0]);
  if (t.isReturnStatement(node)) return node.argument && t.isBooleanLiteral(node.argument) ? node.argument.value : null;
  return null;
}

/** Exact logical negation, flipping equality operators instead of wrapping when possible. */
function negate(expr: t.Expression): t.Expression {
  if (t.isBinaryExpression(expr)) {
    const flip: Record<string, string> = { '===': '!==', '!==': '===', '==': '!=', '!=': '==' };
    if (flip[expr.operator]) return t.binaryExpression(flip[expr.operator] as t.BinaryExpression['operator'], expr.left, expr.right);
  }
  if (t.isUnaryExpression(expr, { operator: '!' }) && isBooleanExpression(expr.argument)) return expr.argument as t.Expression;
  return t.unaryExpression('!', expr);
}

function asBoolean(expr: t.Expression, allowCoerce: boolean): t.Expression | null {
  if (isBooleanExpression(expr)) return expr;
  return allowCoerce ? t.callExpression(t.identifier('Boolean'), [expr]) : null;
}

export const ifReturnBoolean = (coerce: boolean): EcmaRule => ({
  id: coerce ? 'if-return-boolean-coerce' : 'if-return-boolean',
  description: coerce
    ? 'if (c) return true; else return false;  ->  return Boolean(c);  (c may be non-boolean)'
    : 'if (c) return true; else return false;  ->  return c;  (only when c is obviously boolean)',
  level: coerce ? 'cautious' : 'safe',
  apply(ast, ctx) {
    const hits: RuleHit[] = [];
    traverse(ast, {
      IfStatement(path) {
        const { test, consequent, alternate } = path.node;
        const parent = path.parentPath;
        const thenValue = boolLiteralOf(consequent);
        if (thenValue === null || !t.isReturnStatement(t.isBlockStatement(consequent) ? consequent.body[0] : consequent)) return;
        let elseValue: boolean | null = null;
        let sibling: NodePath | null = null;
        if (alternate) {
          if (!t.isReturnStatement(t.isBlockStatement(alternate) ? alternate.body[0] : alternate)) return;
          elseValue = boolLiteralOf(alternate);
        } else if (typeof path.key === 'number' && Array.isArray(parent.node && (parent.node as t.BlockStatement).body)) {
          const next = path.getSibling(path.key + 1);
          if (next.isReturnStatement()) elseValue = boolLiteralOf(next.node);
          if (elseValue !== null) sibling = next;
        }
        if (elseValue === null || elseValue === thenValue) return;
        if (hasComments(path.node) || (alternate && hasComments(alternate))) return;
        let value: t.Expression | null;
        if (thenValue === true) value = asBoolean(test, coerce);
        else value = negate(test);
        if (!value) return;
        const before = text(ctx, path.node);
        if (sibling) sibling.remove();
        path.replaceWith(t.returnStatement(value));
        hits.push({ description: `Replaced if/return ${thenValue}/${elseValue} with a direct return`, loc: loc(path.node), before, confidence: 1 });
      },
    });
    return hits;
  },
});

export const ternaryBoolean = (coerce: boolean): EcmaRule => ({
  id: coerce ? 'ternary-boolean-coerce' : 'ternary-boolean',
  description: coerce ? 'c ? true : false  ->  Boolean(c)' : 'c ? true : false  ->  c  (only when c is obviously boolean); c ? false : true -> !c',
  level: coerce ? 'cautious' : 'safe',
  apply(ast, ctx) {
    const hits: RuleHit[] = [];
    traverse(ast, {
      ConditionalExpression(path) {
        const { test, consequent, alternate } = path.node;
        if (!t.isBooleanLiteral(consequent) || !t.isBooleanLiteral(alternate) || consequent.value === alternate.value) return;
        const value = consequent.value ? asBoolean(test, coerce) : negate(test);
        if (!value) return;
        const before = text(ctx, path.node);
        path.replaceWith(value);
        hits.push({ description: 'Removed a redundant ternary on a boolean', loc: loc(path.node), before });
      },
    });
    return hits;
  },
});

function simplifyTruthiness(node: t.Expression): t.Expression {
  if (t.isUnaryExpression(node, { operator: '!' }) && t.isUnaryExpression(node.argument, { operator: '!' })) return simplifyTruthiness(node.argument.argument);
  if (t.isLogicalExpression(node) && node.operator !== '??') {
    const l = simplifyTruthiness(node.left);
    const r = simplifyTruthiness(node.right);
    if (l !== node.left || r !== node.right) return t.logicalExpression(node.operator, l, r);
  }
  return node;
}

export const redundantDoubleNegation: EcmaRule = {
  id: 'redundant-double-negation',
  description: 'if (!!x)  ->  if (x)  (conditions only use truthiness)',
  level: 'safe',
  apply(ast, ctx) {
    const hits: RuleHit[] = [];
    const fix = (path: NodePath, key: 'test') => {
      const node = path.node as unknown as Record<string, t.Expression | null | undefined>;
      const test = node[key];
      if (!test) return;
      const next = simplifyTruthiness(test);
      if (next !== test) {
        const before = text(ctx, test);
        node[key] = next;
        hits.push({ description: 'Removed a redundant !! in a condition', loc: loc(test), before });
      }
    };
    traverse(ast, {
      IfStatement: (p) => fix(p, 'test'),
      WhileStatement: (p) => fix(p, 'test'),
      DoWhileStatement: (p) => fix(p, 'test'),
      ForStatement: (p) => fix(p, 'test'),
      ConditionalExpression: (p) => fix(p, 'test'),
    });
    return hits;
  },
};

export const elseIfCollapse: EcmaRule = {
  id: 'else-if-collapse',
  description: 'else { if (...) {...} }  ->  else if (...) {...}',
  level: 'safe',
  apply(ast, ctx) {
    const hits: RuleHit[] = [];
    traverse(ast, {
      IfStatement(path) {
        const alt = path.node.alternate;
        if (alt && t.isBlockStatement(alt) && alt.body.length === 1 && t.isIfStatement(alt.body[0]) && !hasComments(alt)) {
          const before = text(ctx, alt);
          path.node.alternate = alt.body[0];
          hits.push({ description: 'Flattened else { if } into else if', loc: loc(alt), before });
        }
      },
    });
    return hits;
  },
};

function terminates(stmt: t.Statement | null | undefined): boolean {
  if (!stmt) return false;
  if (t.isReturnStatement(stmt) || t.isThrowStatement(stmt) || t.isContinueStatement(stmt) || t.isBreakStatement(stmt)) return true;
  if (t.isBlockStatement(stmt)) return stmt.body.length > 0 && terminates(stmt.body[stmt.body.length - 1]);
  return false;
}

function hasLexicalDeclaration(stmts: t.Statement[]): boolean {
  return stmts.some((s) => (t.isVariableDeclaration(s) && s.kind !== 'var') || t.isClassDeclaration(s) || t.isFunctionDeclaration(s) || t.isTSEnumDeclaration(s));
}

export const elseAfterReturn: EcmaRule = {
  id: 'else-after-return',
  description: 'if (c) { return x; } else { ... }  ->  if (c) { return x; } ...  (guard clause)',
  level: 'cautious',
  apply(ast, ctx) {
    const hits: RuleHit[] = [];
    traverse(ast, {
      IfStatement(path) {
        const { consequent, alternate } = path.node;
        if (!alternate || !terminates(consequent)) return;
        const container = path.parentPath;
        if (!(container.isBlockStatement() || container.isProgram() || container.isSwitchCase()) || typeof path.key !== 'number') return;
        const altStmts = t.isBlockStatement(alternate) ? alternate.body : [alternate];
        if (hasLexicalDeclaration(altStmts) || hasComments(alternate)) return;
        const before = text(ctx, path.node);
        path.node.alternate = null;
        path.insertAfter(altStmts);
        hits.push({ description: 'Removed else after a returning branch', loc: loc(path.node), before });
      },
    });
    return hits;
  },
};

export const inlineTempReturn: EcmaRule = {
  id: 'inline-temp-return',
  description: 'const x = expr; return x;  ->  return expr;',
  level: 'safe',
  apply(ast, ctx) {
    const hits: RuleHit[] = [];
    traverse(ast, {
      VariableDeclaration(path) {
        const node = path.node;
        if (node.declarations.length !== 1 || typeof path.key !== 'number') return;
        const decl = node.declarations[0];
        if (!t.isIdentifier(decl.id) || !decl.init || decl.id.typeAnnotation || hasComments(node) || (node as { declare?: boolean }).declare) return;
        if (!(path.parentPath.isBlockStatement() || path.parentPath.isProgram())) return;
        const next = path.getSibling(path.key + 1);
        if (!next.isReturnStatement() || !t.isIdentifier(next.node.argument, { name: decl.id.name }) || hasComments(next.node)) return;
        const binding = path.scope.getBinding(decl.id.name);
        if (!binding || binding.referencePaths.length !== 1 || binding.constantViolations.length > 0) return;
        if (binding.referencePaths[0].node !== next.node.argument) return;
        const before = `${text(ctx, node)} ${text(ctx, next.node)}`;
        next.node.argument = decl.init;
        path.remove();
        hits.push({ description: `Inlined temporary variable "${decl.id.name}" into return`, loc: loc(node), before });
      },
    });
    return hits;
  },
};

export const removeEmptyStatements: EcmaRule = {
  id: 'remove-empty-statements',
  description: 'Removes stray `;` statements',
  level: 'safe',
  apply(ast) {
    const hits: RuleHit[] = [];
    traverse(ast, {
      EmptyStatement(path) {
        if ((path.parentPath.isBlockStatement() || path.parentPath.isProgram()) && !hasComments(path.node)) {
          hits.push({ description: 'Removed an empty statement', loc: loc(path.node) });
          path.remove();
        }
      },
    });
    return hits;
  },
};

export const mergeDuplicateImports: EcmaRule = {
  id: 'merge-duplicate-imports',
  description: "import {a} from 'x'; import {b} from 'x';  ->  import {a, b} from 'x';",
  level: 'safe',
  apply(ast) {
    const hits: RuleHit[] = [];
    const groups = new Map<string, t.ImportDeclaration[]>();
    for (const stmt of ast.program.body) {
      if (!t.isImportDeclaration(stmt) || stmt.specifiers.length === 0 || stmt.phase || (stmt.attributes && stmt.attributes.length)) continue;
      if (stmt.specifiers.some((s) => t.isImportNamespaceSpecifier(s))) continue;
      if (hasComments(stmt)) continue;
      const key = `${stmt.importKind ?? 'value'}:${stmt.source.value}`;
      const list = groups.get(key) ?? [];
      list.push(stmt);
      groups.set(key, list);
    }
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const [first, ...rest] = list;
      const seen = new Set(first.specifiers.map((s) => `${(s as t.ImportSpecifier).imported ? (t.isIdentifier((s as t.ImportSpecifier).imported) ? ((s as t.ImportSpecifier).imported as t.Identifier).name : '') : 'default'}>${s.local.name}`));
      const hasDefault = first.specifiers.some((s) => t.isImportDefaultSpecifier(s));
      let mergedDefault = hasDefault;
      let ok = true;
      for (const d of rest) {
        for (const s of d.specifiers) {
          if (t.isImportDefaultSpecifier(s)) {
            if (mergedDefault) ok = false;
            mergedDefault = true;
          }
        }
      }
      if (!ok) continue;
      for (const d of rest) {
        for (const s of d.specifiers) {
          const key = t.isImportDefaultSpecifier(s) ? `default>${s.local.name}` : `${t.isIdentifier((s as t.ImportSpecifier).imported) ? ((s as t.ImportSpecifier).imported as t.Identifier).name : ''}>${s.local.name}`;
          if (!seen.has(key)) {
            seen.add(key);
            if (t.isImportDefaultSpecifier(s)) first.specifiers.unshift(s);
            else first.specifiers.push(s);
          }
        }
        ast.program.body.splice(ast.program.body.indexOf(d), 1);
      }
      hits.push({ description: `Merged ${list.length} imports from "${first.source.value}"`, loc: loc(first) });
    }
    return hits;
  },
};

export const sortImports: EcmaRule = {
  id: 'sort-imports',
  description: 'Orders the leading import block: packages first, then relative paths, alphabetically',
  level: 'cautious',
  apply(ast) {
    const body = ast.program.body;
    let end = 0;
    while (end < body.length && t.isImportDeclaration(body[end])) end++;
    if (end < 3) return [];
    const block = body.slice(0, end) as t.ImportDeclaration[];
    // Re-ordering imports can change module evaluation order; refuse when any import is for side effects only.
    if (block.some((d) => d.specifiers.length === 0)) return [];
    const rank = (d: t.ImportDeclaration) => (d.source.value.startsWith('.') ? 1 : 0);
    const sorted = [...block].sort((a, b) => rank(a) - rank(b) || (a.source.value < b.source.value ? -1 : a.source.value > b.source.value ? 1 : 0));
    if (sorted.every((d, i) => d === block[i])) return [];
    body.splice(0, end, ...sorted);
    return [{ description: 'Sorted import declarations', loc: loc(block[0]) }];
  },
};

export const varToLetConst: EcmaRule = {
  id: 'var-to-let-const',
  description: 'var -> const/let when the variable is only used inside its block after its declaration',
  level: 'cautious',
  apply(ast, ctx) {
    const hits: RuleHit[] = [];
    traverse(ast, {
      VariableDeclaration(path) {
        const node = path.node;
        if (node.kind !== 'var' || (node as { declare?: boolean }).declare) return;
        const parent = path.parentPath;
        if (!(parent.isBlockStatement() || parent.isProgram())) return; // not for-init, not labelled etc.
        if (parent.isProgram() && !ctx.isModule) return; // global var creates window properties
        const block = parent.node as t.BlockStatement | t.Program;
        const inLoop = !!path.findParent((p) => p.isLoop());
        const insideFunctionLevelBlock = parent.isProgram() || (parent.isBlockStatement() && parent.parentPath.isFunction());
        let kinds: ('const' | 'let')[] = [];
        for (const d of node.declarations) {
          if (!t.isIdentifier(d.id)) return;
          const b = path.scope.getBinding(d.id.name);
          if (!b || b.scope !== path.scope) return;
          if (b.path.node !== d) return; // redeclared elsewhere
          // all references must be after the declaration and inside the same block
          for (const ref of [...b.referencePaths, ...b.constantViolations]) {
            if (ref.node.start == null || d.end == null || ref.node.start < d.end) return;
            if (!ref.findParent((p) => p.node === block) && ref.parentPath !== parent) return;
            // a closure capturing a loop variable would change meaning with let/const
            if (inLoop && ref.getFunctionParent() !== path.getFunctionParent()) return;
          }
          // block-scoped bindings in switch-case / nested blocks are not function-level `var`s
          if (!insideFunctionLevelBlock && b.referencePaths.some((r) => !r.findParent((p) => p.node === block))) return;
          kinds.push(b.constantViolations.length === 0 && d.init ? 'const' : 'let');
        }
        if (kinds.length === 0) return;
        const kind: 'const' | 'let' = kinds.every((k) => k === 'const') ? 'const' : 'let';
        const before = text(ctx, node);
        node.kind = kind;
        hits.push({ description: `var -> ${kind}`, loc: loc(node), before: snippet(before ?? '', 60) });
      },
    });
    return hits;
  },
};

export const functionToArrow: EcmaRule = {
  id: 'callback-to-arrow',
  description: 'function () {...} callbacks -> arrow functions when `this`/`arguments` are not used',
  level: 'aggressive',
  apply(ast, ctx) {
    const hits: RuleHit[] = [];
    traverse(ast, {
      FunctionExpression(path) {
        const fn = path.node;
        if (fn.generator || fn.id || !path.parentPath.isCallExpression() || !path.parentPath.node.arguments.includes(fn)) return;
        const callee = path.parentPath.node.callee;
        if (t.isIdentifier(callee, { name: 'require' }) || t.isMemberExpression(callee) && t.isIdentifier(callee.property, { name: 'call' })) return;
        let unsafe = false;
        path.traverse({
          ThisExpression(p) { if (p.getFunctionParent() === path) unsafe = true; },
          Super(p) { if (p.getFunctionParent() === path) unsafe = true; },
          Identifier(p) { if (p.node.name === 'arguments' && p.getFunctionParent() === path) unsafe = true; },
          MetaProperty(p) { if (p.getFunctionParent() === path) unsafe = true; },
        });
        if (unsafe || hasComments(fn)) return;
        const before = text(ctx, fn);
        const arrow = t.arrowFunctionExpression(fn.params, fn.body, fn.async);
        path.replaceWith(arrow);
        hits.push({ description: 'Converted a function callback to an arrow function', loc: loc(fn), before: snippet(before ?? '', 60) });
      },
    });
    return hits;
  },
};

// ---- Dead code removal (only with removeUnused) ----------------------------------------------

function wordCount(source: string, name: string): number {
  const re = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g');
  return (source.match(re) ?? []).length;
}

export const removeUnusedImports: EcmaRule = {
  id: 'remove-unused-imports',
  description: 'Removes import specifiers that are never referenced (side-effect imports are kept)',
  level: 'cautious',
  apply(ast, ctx) {
    if (!ctx.removeUnused) return [];
    const hits: RuleHit[] = [];
    traverse(ast, {
      ImportDeclaration(path) {
        const node = path.node;
        if (node.specifiers.length === 0 || hasComments(node)) return;
        const keep = node.specifiers.filter((s) => {
          const name = s.local.name;
          const b = path.scope.getBinding(name);
          if (!b) return true;
          if (b.referenced) return true;
          if (ctx.hasJsx && ['React', 'h', 'Fragment'].includes(name)) return true;
          if (isBindingExported(b)) return true;
          // Textual guard: names also seen elsewhere (e.g. TS type positions, JSDoc) stay.
          return wordCount(ctx.source, name) > 1;
        });
        if (keep.length === node.specifiers.length) return;
        const removed = node.specifiers.filter((s) => !keep.includes(s)).map((s) => s.local.name);
        hits.push({ description: `Removed unused import${removed.length > 1 ? 's' : ''}: ${removed.join(', ')}`, loc: loc(node), confidence: 0.95 });
        // Dropping every specifier must not drop the module's side effects: keep a bare import.
        if (keep.length === 0 && (node.importKind === 'type' || node.importKind === 'typeof')) path.remove();
        else node.specifiers = keep;
      },
    });
    return hits;
  },
};

export const removeUnreachable: EcmaRule = {
  id: 'remove-unreachable-code',
  description: 'Removes statements after return/throw/break/continue (hoisted declarations are kept)',
  level: 'cautious',
  apply(ast, ctx) {
    if (!ctx.removeUnused) return [];
    const hits: RuleHit[] = [];
    const prune = (list: t.Statement[]): void => {
      const idx = list.findIndex((s) => t.isReturnStatement(s) || t.isThrowStatement(s) || t.isBreakStatement(s) || t.isContinueStatement(s));
      if (idx < 0 || idx === list.length - 1) return;
      const keep = (s: t.Statement) => t.isFunctionDeclaration(s) || (t.isVariableDeclaration(s) && s.kind === 'var') || t.isEmptyStatement(s) || hasComments(s);
      const tail = list.slice(idx + 1);
      const removable = tail.filter((s) => !keep(s));
      if (!removable.length) return;
      hits.push({ description: `Removed ${removable.length} unreachable statement${removable.length > 1 ? 's' : ''}`, loc: loc(removable[0]), before: text(ctx, removable[0]), confidence: 0.95 });
      list.splice(idx + 1, list.length - idx - 1, ...tail.filter(keep));
    };
    traverse(ast, {
      BlockStatement: (p) => prune(p.node.body),
      Program: (p) => prune(p.node.body),
      SwitchCase: (p) => prune(p.node.consequent),
    });
    return hits;
  },
};

function isPure(node: t.Node | null | undefined): boolean {
  if (!node) return true;
  if (t.isLiteral(node) && !t.isTemplateLiteral(node)) return true;
  if (t.isTemplateLiteral(node)) return node.expressions.every(isPure);
  if (t.isIdentifier(node) || t.isFunction(node)) return true;
  if (t.isArrayExpression(node)) return node.elements.every((e) => e !== null && !t.isSpreadElement(e) && isPure(e));
  if (t.isObjectExpression(node)) return node.properties.every((p) => t.isObjectProperty(p) && !p.computed && isPure(p.value));
  if (t.isUnaryExpression(node) && node.operator !== 'delete') return isPure(node.argument);
  return false;
}

export const removeUnusedLocals: EcmaRule = {
  id: 'remove-unused-locals',
  description: 'Removes unreferenced local variables/functions whose initializers have no side effects',
  level: 'aggressive',
  apply(ast, ctx) {
    if (!ctx.removeUnused) return [];
    const hits: RuleHit[] = [];
    const visitedFn = new Set<t.Node>();
    traverse(ast, {
      VariableDeclaration(path) {
        const node = path.node;
        if (node.declarations.length !== 1 || (node as { declare?: boolean }).declare || hasComments(node)) return;
        const d = node.declarations[0];
        if (!t.isIdentifier(d.id) || !isPure(d.init)) return;
        if (path.parentPath.isExportNamedDeclaration() || !(path.parentPath.isBlockStatement() || path.parentPath.isProgram())) return;
        const b = path.scope.getBinding(d.id.name);
        if (!b || b.referenced || b.constantViolations.length) return;
        if (path.scope.path.isProgram() && !ctx.isModule) return;
        if (isBindingExported(b) || wordCount(ctx.source, d.id.name) > 1) return;
        hits.push({ description: `Removed unused variable "${d.id.name}"`, loc: loc(node), confidence: 0.9 });
        path.remove();
      },
      FunctionDeclaration(path) {
        const node = path.node;
        if (!node.id || visitedFn.has(node) || hasComments(node) || path.parentPath.isExportNamedDeclaration() || path.parentPath.isExportDefaultDeclaration()) return;
        visitedFn.add(node);
        const scope = path.scope.parent ?? path.scope;
        const b = scope.getBinding(node.id.name);
        if (!b || b.referenced || b.constantViolations.length || (scope.path.isProgram() && !ctx.isModule)) return;
        if (isBindingExported(b) || wordCount(ctx.source, node.id.name) > 1) return;
        hits.push({ description: `Removed unused function "${node.id.name}"`, loc: loc(node), confidence: 0.9 });
        path.remove();
      },
    });
    return hits;
  },
};

export const ECMA_RULES: EcmaRule[] = [
  removeEmptyStatements,
  ifReturnBoolean(false),
  ifReturnBoolean(true),
  ternaryBoolean(false),
  ternaryBoolean(true),
  redundantDoubleNegation,
  inlineTempReturn,
  elseIfCollapse,
  elseAfterReturn,
  mergeDuplicateImports,
  sortImports,
  varToLetConst,
  removeUnusedImports,
  removeUnreachable,
  functionToArrow,
  removeUnusedLocals,
];
