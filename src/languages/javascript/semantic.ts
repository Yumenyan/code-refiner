import * as t from '@babel/types';
import type { Loc } from '../../core/types.js';
import { fingerprint, snippet } from '../../core/text.js';
import type {
  CallEdge, DataFlowEdge, DomRef, ExportInfo, FileSemantic, FunctionInfo, ImportInfo, UnreachableCode, VariableInfo,
} from '../../semantic/model.js';
import { inferValue } from './value-facts.js';
import { parseEcma, type EcmaLanguage } from './parser.js';
import { traverse, type NodePath, type Scope, type Binding } from './traverse.js';

const loc = (n: t.Node | null | undefined): Loc => ({ line: n?.loc?.start.line ?? 0, column: (n?.loc?.start.column ?? 0) + 1 });

const MAX_STRINGS = 4000;

function functionName(path: NodePath<t.Function>): string {
  const n = path.node;
  if ((t.isFunctionDeclaration(n) || t.isFunctionExpression(n)) && n.id) return n.id.name;
  const p = path.parentPath;
  if (p?.isVariableDeclarator() && t.isIdentifier(p.node.id)) return p.node.id.name;
  if (p?.isAssignmentExpression()) {
    const l = p.node.left;
    if (t.isIdentifier(l)) return l.name;
    if (t.isMemberExpression(l) && t.isIdentifier(l.property)) return l.property.name;
  }
  if ((t.isObjectMethod(n) || t.isClassMethod(n) || t.isClassPrivateMethod(n)) && !n.computed) {
    if (t.isIdentifier(n.key)) {
      const cls = path.findParent((q) => q.isClass());
      const clsName = cls && t.isClass(cls.node) && cls.node.id ? cls.node.id.name + '.' : '';
      return clsName + n.key.name;
    }
  }
  if (p?.isObjectProperty() && t.isIdentifier(p.node.key)) return p.node.key.name;
  if (p?.isClassProperty() && t.isIdentifier(p.node.key)) return p.node.key.name;
  return `<anonymous>@${n.loc?.start.line ?? 0}`;
}

function isInsideExport(path: NodePath): boolean {
  let p: NodePath | null = path;
  while (p) {
    if (p.isExportNamedDeclaration() || p.isExportDefaultDeclaration()) return true;
    if (p !== path && (p.isProgram() || p.isFunction() || p.isBlockStatement())) return false;
    p = p.parentPath;
  }
  return false;
}

function isCommonJsExportTarget(node: t.Node): boolean {
  // module.exports / exports.x / module.exports.x
  let n: t.Node = node;
  while (t.isMemberExpression(n)) n = n.object;
  if (t.isIdentifier(n, { name: 'exports' })) return true;
  return t.isMemberExpression(node) && t.isIdentifier(node.object, { name: 'module' }) && t.isIdentifier(node.property, { name: 'exports' }) || (t.isMemberExpression(node) && isModuleExportsChain(node));
}
function isModuleExportsChain(node: t.MemberExpression): boolean {
  let n: t.Node = node;
  while (t.isMemberExpression(n)) {
    if (t.isIdentifier(n.object, { name: 'module' }) && t.isIdentifier(n.property, { name: 'exports' })) return true;
    n = n.object;
  }
  return false;
}

/** True when this reference ends up exported (ES export specifier/default, or CommonJS exports). */
export function isReferenceExported(ref: NodePath): boolean {
  const parent = ref.parentPath;
  if (!parent) return false;
  if (parent.isExportSpecifier() || parent.isExportDefaultDeclaration()) return true;
  let p: NodePath | null = parent;
  while (p && !p.isStatement()) {
    if (p.isAssignmentExpression() && isCommonJsExportTarget(p.node.left)) return true;
    p = p.parentPath;
  }
  if (p?.isExpressionStatement() && t.isAssignmentExpression(p.node.expression) && isCommonJsExportTarget(p.node.expression.left)) return true;
  return false;
}

export function isBindingExported(binding: Binding): boolean {
  if (isInsideExport(binding.path)) return true;
  return binding.referencePaths.some(isReferenceExported);
}

function scopeKind(scope: Scope, isModule: boolean): VariableInfo['scopeKind'] {
  const p = scope.path;
  if (p.isProgram()) return isModule ? 'module' : 'global';
  if (p.isFunction()) return 'function';
  return 'block';
}

function bindingKind(b: Binding): VariableInfo['kind'] | null {
  switch (b.kind) {
    case 'var': return 'var';
    case 'let': return 'let';
    case 'const': return 'const';
    case 'param': return 'param';
    case 'hoisted': return 'function';
    case 'module': return 'import';
    case 'local': return b.path.isClassDeclaration() || b.path.isClassExpression() ? 'class' : b.path.isCatchClause() ? 'catch' : 'function';
    default:
      return null;
  }
}

/** Structural hash of a function ignoring local identifier names and literal values. */
function structuralHash(fn: NodePath<t.Function>): { hash: string; size: number } {
  const ids = new Map<string, number>();
  let size = 0;
  const parts: string[] = [];
  const localNames = new Set<string>(Object.keys(fn.scope.bindings));
  const props = new Map<string, number>();
  const visit = (node: t.Node, parent?: t.Node): void => {
    size++;
    // `item.size` and `item.weight` are the same shape; method names (`a.push(...)`) are not.
    if (t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.property)) {
      parts.push('Member(');
      visit(node.object, node);
      const isCallee = !!parent && t.isCallExpression(parent) && parent.callee === node;
      parts.push(isCallee ? `.${node.property.name}` : '.#');
      parts.push(')');
      return;
    }
    switch (node.type) {
      case 'Identifier':
        if (localNames.has(node.name)) {
          if (!ids.has(node.name)) ids.set(node.name, ids.size);
          parts.push(`$${ids.get(node.name)}`);
        } else parts.push(`I:${node.name}`);
        return;
      case 'StringLiteral': parts.push('S'); return;
      case 'NumericLiteral': parts.push('N'); return;
      case 'BooleanLiteral': parts.push(`B${node.value}`); return;
      case 'TemplateElement': parts.push('TE'); return;
      default: break;
    }
    parts.push(node.type + '(');
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      if (key === 'id' && t.isFunction(node)) continue;
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) child.forEach((c) => c && visit(c as t.Node, node));
      else if (child) {
        parts.push(key + ':');
        visit(child as t.Node, node);
      }
    }
    parts.push(')');
  };
  visit(fn.node.body);
  fn.node.params.forEach((p) => visit(p));
  return { hash: fingerprint(parts.join(' ')), size };
}

const BRANCHY = new Set(['IfStatement', 'ConditionalExpression', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement', 'CatchClause']);
const NESTING = new Set(['IfStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement', 'SwitchStatement', 'TryStatement']);

function measureFunction(fn: NodePath<t.Function>): { cyclomatic: number; maxNesting: number; returnsValue: boolean } {
  let cyclomatic = 1;
  let maxNesting = 0;
  let returnsValue = t.isArrowFunctionExpression(fn.node) && !t.isBlockStatement(fn.node.body);
  const visit = (node: t.Node, depth: number): void => {
    if (BRANCHY.has(node.type)) cyclomatic++;
    else if (t.isLogicalExpression(node)) cyclomatic++;
    else if (t.isSwitchCase(node) && node.test) cyclomatic++;
    else if (t.isReturnStatement(node) && node.argument) returnsValue = true;
    let d = depth;
    if (NESTING.has(node.type)) {
      // `else if` does not add depth
      d = depth + 1;
      maxNesting = Math.max(maxNesting, d);
    }
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      const go = (c: t.Node): void => {
        if (t.isFunction(c)) return; // nested functions measured on their own
        let nd = d;
        if (t.isIfStatement(node) && key === 'alternate' && t.isIfStatement(c)) nd = depth; // else-if chain
        visit(c, nd);
      };
      if (Array.isArray(child)) child.forEach((c) => c && go(c as t.Node));
      else if (child) go(child as t.Node);
    }
  };
  visit(fn.node.body, 0);
  return { cyclomatic, maxNesting, returnsValue };
}

function selectorTokens(sel: string): { classes: string[]; ids: string[]; data: string[] } {
  const classes = [...sel.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);
  const ids = [...sel.matchAll(/#(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);
  const data = [...sel.matchAll(/\[\s*(data-[\w-]+)/g)].map((m) => m[1]);
  return { classes, ids, data };
}

const camelToKebab = (s: string) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

export function analyzeEcma(source: string, file: string, language: EcmaLanguage): FileSemantic | { error: string } {
  try {
    return analyzeEcmaUnsafe(source, file, language);
  } catch (e) {
    return { error: (e as Error).message };
  }
}

function analyzeEcmaUnsafe(source: string, file: string, language: EcmaLanguage): FileSemantic | { error: string } {
  let ast: t.File;
  try {
    ast = parseEcma(source, file, language);
  } catch (e) {
    return { error: (e as Error).message };
  }

  const variables: VariableInfo[] = [];
  const functions: FunctionInfo[] = [];
  const dataFlow: DataFlowEdge[] = [];
  const calls: CallEdge[] = [];
  const domRefs: DomRef[] = [];
  const unreachable: UnreachableCode[] = [];
  const strings: string[] = [];
  const imports: ImportInfo[] = [];
  const exportsList: ExportInfo[] = [];
  const functionHashes: FileSemantic['functionHashes'] = [];
  const fnIds = new WeakMap<t.Node, string>();
  const fnInfoById = new Map<string, FunctionInfo>();
  const seenScopes = new Set<Scope>();
  const scopeIds = new WeakMap<Scope, string>();
  let scopeCounter = 0;
  let hasDynamicScope = false;
  let stringBytes = 0;

  const isModule = ast.program.sourceType === 'module';
  const varId = (name: string, n: t.Node) => `${file}::${name}@${n.loc?.start.line ?? 0}:${(n.loc?.start.column ?? 0) + 1}`;
  const bindingIds = new WeakMap<Binding, string>();
  const idOf = (b: Binding) => {
    let id = bindingIds.get(b);
    if (!id) bindingIds.set(b, (id = varId(b.identifier.name, b.identifier)));
    return id;
  };

  // element variables -> DOM target, for event wiring
  const elementTargets = new Map<Binding, string>();

  const addStrings = (v: string) => {
    if (v.length > 200 || v.length === 0 || stringBytes > 500_000 || strings.length >= MAX_STRINGS) return;
    strings.push(v);
    stringBytes += v.length;
  };

  const identifierCounts: Record<string, number> = Object.create(null);
  const countIdentifier = (n: string) => {
    identifierCounts[n] = (identifierCounts[n] ?? 0) + 1;
  };
  const pushDomRef = (r: Omit<DomRef, 'file'>) => domRefs.push({ file, ...r });
  const literalOf = (n: t.Node | null | undefined): string | undefined =>
    n && t.isStringLiteral(n) ? n.value : n && t.isTemplateLiteral(n) && n.expressions.length === 0 ? n.quasis[0].value.cooked ?? undefined : undefined;

  const enclosingFunctionId = (path: NodePath): string => {
    const fn = path.getFunctionParent();
    return fn ? fnIds.get(fn.node) ?? '<module>' : '<module>';
  };

  // First pass: function ids, so the call graph can resolve forward references.
  traverse(ast, {
    Function(path) {
      const name = functionName(path as NodePath<t.Function>);
      fnIds.set(path.node, `${file}::${name}@${path.node.loc?.start.line ?? 0}`);
    },
  });

  const resolveCallee = (path: NodePath<t.CallExpression>): string => {
    const callee = path.node.callee;
    if (t.isIdentifier(callee)) {
      const b = path.scope.getBinding(callee.name);
      if (b) {
        if (b.path.isFunction()) return fnIds.get(b.path.node) ?? `?${callee.name}`;
        if (b.path.isVariableDeclarator() && b.path.node.init && t.isFunction(b.path.node.init)) return fnIds.get(b.path.node.init) ?? `?${callee.name}`;
        if (b.kind === 'module') return `import:${callee.name}`;
      }
      return `?${callee.name}`;
    }
    if (t.isMemberExpression(callee) && !callee.computed && t.isIdentifier(callee.property)) {
      const obj = t.isIdentifier(callee.object) ? callee.object.name : t.isThisExpression(callee.object) ? 'this' : '';
      return `?${obj ? obj + '.' : '.'}${callee.property.name}`;
    }
    return '?<dynamic>';
  };

  traverse(ast, {
    Scopable(path) {
      const scope = path.scope;
      if (seenScopes.has(scope)) return;
      seenScopes.add(scope);
      const sid = `${file}#s${scopeCounter++}`;
      scopeIds.set(scope, sid);
      for (const [name, b] of Object.entries(scope.bindings)) {
        if (!b) continue; // TS ambient declarations can leave holes
        const kind = bindingKind(b);
        if (!kind) continue;
        let init: t.Node | null | undefined;
        if (b.path.isVariableDeclarator()) init = b.path.node.init;
        const info = inferValue(init, scope);
        const exported = isBindingExported(b);
        variables.push({
          id: idOf(b),
          name,
          file,
          kind,
          scope: sid,
          scopeKind: scopeKind(scope, isModule),
          loc: loc(b.identifier),
          valueType: info.valueType === 'unknown' ? (kind === 'function' ? 'function' : undefined) : info.valueType,
          init: init && init.start != null && init.end != null ? snippet(source.slice(init.start, init.end), 90) : undefined,
          sources: info.sources.map((s) => {
            const sb = scope.getBinding(s);
            return sb ? idOf(sb) : s;
          }),
          references: b.referencePaths.map((r) => loc(r.node)),
          assignments: b.constantViolations.length,
          exported,
        });
        // data flow: sources -> this variable
        for (const s of info.sources) {
          const sb = scope.getBinding(s);
          dataFlow.push({ file, from: sb ? idOf(sb) : s, to: idOf(b), via: info.via ?? 'assign', loc: loc(b.identifier) });
        }
        // data flow: this variable -> consumers (function call arguments, returns)
        for (const ref of b.referencePaths) {
          const parent = ref.parentPath;
          if (parent?.isCallExpression() && parent.node.arguments.includes(ref.node as t.Expression)) {
            const idx = parent.node.arguments.indexOf(ref.node as t.Expression);
            dataFlow.push({ file, from: idOf(b), to: `${resolveCallee(parent as NodePath<t.CallExpression>)}#arg${idx}`, via: 'argument', loc: loc(ref.node) });
          } else if (parent?.isReturnStatement()) {
            dataFlow.push({ file, from: idOf(b), to: `${enclosingFunctionId(ref)}#return`, via: 'return', loc: loc(ref.node) });
          }
        }
      }
    },

    Function(path) {
      const fn = path as NodePath<t.Function>;
      const id = fnIds.get(fn.node)!;
      const name = functionName(fn);
      const m = measureFunction(fn);
      const startLine = fn.node.loc?.start.line ?? 0;
      const endLine = fn.node.loc?.end.line ?? startLine;
      const exported =
        isInsideExport(fn) ||
        (fn.isFunctionDeclaration() && fn.node.id ? (fn.scope.parent?.getBinding(fn.node.id.name) ?? fn.scope.getBinding(fn.node.id.name) ? isBindingExported((fn.scope.parent ?? fn.scope).getBinding(fn.node.id.name)!) : false) : false) ||
        (fn.parentPath.isVariableDeclarator() && t.isIdentifier(fn.parentPath.node.id) ? (() => { const b = fn.scope.getBinding(fn.parentPath.node.id.name) ?? fn.scope.parent?.getBinding((fn.parentPath.node.id as t.Identifier).name); return b ? isBindingExported(b) : false; })() : false);
      const hash = structuralHash(fn);
      if (hash.size >= 20) functionHashes.push({ id, name, loc: loc(fn.node), hash: hash.hash, size: hash.size, lines: endLine - startLine + 1 });
      const info: FunctionInfo = {
        id,
        name,
        file,
        loc: loc(fn.node),
        params: fn.node.params.map((p) => (t.isIdentifier(p) ? p.name : t.isAssignmentPattern(p) && t.isIdentifier(p.left) ? p.left.name : t.isRestElement(p) && t.isIdentifier(p.argument) ? '...' + p.argument.name : '{…}')),
        returnsValue: m.returnsValue,
        async: fn.node.async === true,
        generator: fn.node.generator === true,
        exported,
        lines: endLine - startLine + 1,
        cyclomatic: m.cyclomatic,
        maxNesting: m.maxNesting,
        calls: [],
      };
      functions.push(info);
      fnInfoById.set(id, info);
    },

    CallExpression(path) {
      const node = path.node;
      const callerId = enclosingFunctionId(path);
      const callee = resolveCallee(path);
      calls.push({ file, caller: callerId, callee, loc: loc(node) });
      const fnInfo = fnInfoById.get(callerId);
      if (fnInfo && !fnInfo.calls.includes(callee)) fnInfo.calls.push(callee);

      if (t.isIdentifier(node.callee, { name: 'eval' }) || (t.isIdentifier(node.callee, { name: 'Function' }))) hasDynamicScope = true;

      // require('x')
      if (t.isIdentifier(node.callee, { name: 'require' }) && !path.scope.hasBinding('require') && node.arguments.length === 1) {
        const src = literalOf(node.arguments[0]);
        if (src) {
          const parent = path.parentPath;
          const specs: ImportInfo['specifiers'] = [];
          if (parent.isVariableDeclarator()) {
            if (t.isIdentifier(parent.node.id)) specs.push({ imported: '*', local: parent.node.id.name });
            else if (t.isObjectPattern(parent.node.id)) {
              for (const p of parent.node.id.properties) {
                if (t.isObjectProperty(p) && t.isIdentifier(p.key) && t.isIdentifier(p.value)) specs.push({ imported: p.key.name, local: p.value.name });
              }
            }
          }
          imports.push({ source: src, specifiers: specs, loc: loc(node), sideEffectOnly: specs.length === 0 });
        }
      }
      if (t.isImport(node.callee)) {
        const src = literalOf(node.arguments[0]);
        if (src) imports.push({ source: src, specifiers: [], loc: loc(node), sideEffectOnly: false });
      }

      // ---- DOM references -------------------------------------------------------------
      if (t.isMemberExpression(node.callee) && !node.callee.computed && t.isIdentifier(node.callee.property)) {
        const method = node.callee.property.name;
        const arg0 = literalOf(node.arguments[0]);
        const objNode = node.callee.object;
        if (arg0 !== undefined) {
          if (method === 'getElementById') pushDomRef({ kind: 'id', value: arg0, loc: loc(node) });
          else if (method === 'getElementsByClassName') arg0.split(/\s+/).filter(Boolean).forEach((c) => pushDomRef({ kind: 'class', value: c, loc: loc(node) }));
          else if (method === 'getElementsByTagName') pushDomRef({ kind: 'tag', value: arg0.toLowerCase(), loc: loc(node) });
          else if (method === 'querySelector' || method === 'querySelectorAll' || method === 'closest' || method === 'matches') {
            pushDomRef({ kind: 'selector', value: arg0, loc: loc(node) });
            const tok = selectorTokens(arg0);
            tok.classes.forEach((c) => pushDomRef({ kind: 'class', value: c, loc: loc(node) }));
            tok.ids.forEach((c) => pushDomRef({ kind: 'id', value: c, loc: loc(node) }));
            tok.data.forEach((c) => pushDomRef({ kind: 'data', value: c, loc: loc(node) }));
          } else if (method === 'getAttribute' || method === 'setAttribute' || method === 'hasAttribute' || method === 'removeAttribute') {
            if (arg0.startsWith('data-')) pushDomRef({ kind: 'data', value: arg0, loc: loc(node) });
          } else if (['add', 'remove', 'toggle', 'contains', 'replace'].includes(method) && t.isMemberExpression(objNode) && t.isIdentifier(objNode.property, { name: 'classList' })) {
            node.arguments.forEach((a) => {
              const v = literalOf(a);
              if (v) v.split(/\s+/).filter(Boolean).forEach((c) => pushDomRef({ kind: 'class', value: c, loc: loc(node) }));
            });
          }
        }
        if (method === 'addEventListener' && node.arguments.length >= 2) {
          const ev = literalOf(node.arguments[0]);
          if (ev) {
            const h = node.arguments[1];
            let target: string | undefined;
            if (t.isIdentifier(objNode)) {
              const b = path.scope.getBinding(objNode.name);
              if (b) target = elementTargets.get(b);
              else if (objNode.name === 'document' || objNode.name === 'window') target = objNode.name;
            } else if (t.isCallExpression(objNode)) {
              target = domTargetOf(objNode);
            }
            pushDomRef({ kind: 'event', value: ev, event: ev, handler: t.isIdentifier(h) ? h.name : undefined, target, loc: loc(node) });
          }
        }
      }
    },

    AssignmentExpression(path) {
      const { left, right } = path.node;
      if (t.isMemberExpression(left) && !left.computed && t.isIdentifier(left.property)) {
        const prop = left.property.name;
        if (prop === 'className') {
          const v = literalOf(right);
          if (v) v.split(/\s+/).filter(Boolean).forEach((c) => pushDomRef({ kind: 'class', value: c, loc: loc(path.node) }));
        }
        if (prop.startsWith('on') && prop.length > 2 && t.isIdentifier(right)) {
          let target: string | undefined;
          if (t.isIdentifier(left.object)) {
            const b = path.scope.getBinding(left.object.name);
            if (b) target = elementTargets.get(b);
          } else if (t.isCallExpression(left.object)) target = domTargetOf(left.object);
          pushDomRef({ kind: 'event', value: prop.slice(2), event: prop.slice(2), handler: right.name, target, loc: loc(path.node) });
        }
        // window.fn = ... / globalThis.fn = ...
        if (t.isIdentifier(left.object) && ['window', 'globalThis', 'self'].includes(left.object.name)) {
          pushDomRef({ kind: 'handler-global', value: prop, loc: loc(path.node) });
        }
      }
    },

    MemberExpression(path) {
      const n = path.node;
      // el.dataset.fooBar
      if (!n.computed && t.isIdentifier(n.property) && t.isMemberExpression(n.object) && t.isIdentifier(n.object.property, { name: 'dataset' })) {
        pushDomRef({ kind: 'data', value: 'data-' + camelToKebab(n.property.name), loc: loc(n) });
      }
    },

    Identifier(path) {
      countIdentifier(path.node.name);
    },
    JSXIdentifier(path) {
      countIdentifier(path.node.name);
    },
    StringLiteral(path) {
      addStrings(path.node.value);
    },
    TemplateElement(path) {
      if (path.node.value.cooked) addStrings(path.node.value.cooked);
    },

    ImportDeclaration(path) {
      const n = path.node;
      imports.push({
        source: n.source.value,
        specifiers: n.specifiers.map((s) =>
          t.isImportDefaultSpecifier(s)
            ? { imported: 'default', local: s.local.name }
            : t.isImportNamespaceSpecifier(s)
              ? { imported: '*', local: s.local.name }
              : { imported: t.isIdentifier(s.imported) ? s.imported.name : s.imported.value, local: s.local.name },
        ),
        loc: loc(n),
        sideEffectOnly: n.specifiers.length === 0,
      });
    },
    ExportNamedDeclaration(path) {
      const n = path.node;
      if (n.declaration) {
        const d = n.declaration;
        if (t.isVariableDeclaration(d)) {
          for (const decl of d.declarations) {
            for (const name of Object.keys(t.getBindingIdentifiers(decl.id))) exportsList.push({ name, kind: 'named', loc: loc(n) });
          }
        } else if ((t.isFunctionDeclaration(d) || t.isClassDeclaration(d)) && d.id) exportsList.push({ name: d.id.name, kind: 'named', loc: loc(n) });
        else if ((t.isTSInterfaceDeclaration(d) || t.isTSTypeAliasDeclaration(d) || t.isTSEnumDeclaration(d)) && d.id) exportsList.push({ name: d.id.name, kind: 'named', loc: loc(n) });
      }
      for (const s of n.specifiers) {
        if (t.isExportSpecifier(s)) exportsList.push({ name: t.isIdentifier(s.exported) ? s.exported.name : s.exported.value, kind: n.source ? 'reexport' : 'named', source: n.source?.value, loc: loc(n) });
      }
      if (n.source) imports.push({ source: n.source.value, specifiers: [], loc: loc(n), sideEffectOnly: false });
    },
    ExportDefaultDeclaration(path) {
      exportsList.push({ name: 'default', kind: 'default', loc: loc(path.node) });
    },
    ExportAllDeclaration(path) {
      exportsList.push({ name: '*', kind: 'all', source: path.node.source.value, loc: loc(path.node) });
      imports.push({ source: path.node.source.value, specifiers: [], loc: loc(path.node), sideEffectOnly: false });
    },

    WithStatement() {
      hasDynamicScope = true;
    },

    // Unreachable statements after an unconditional jump.
    BlockStatement(path) {
      collectUnreachable(path.node.body);
    },
    Program(path) {
      collectUnreachable(path.node.body);
    },
    SwitchCase(path) {
      collectUnreachable(path.node.consequent);
    },
  });

  // DOM target helper uses the pushDomRef-less static analysis.
  function domTargetOf(call: t.CallExpression): string | undefined {
    if (!t.isMemberExpression(call.callee) || !t.isIdentifier(call.callee.property)) return undefined;
    const v = literalOf(call.arguments[0]);
    if (v === undefined) return undefined;
    const m = call.callee.property.name;
    if (m === 'getElementById') return `#${v}`;
    if (m === 'querySelector' || m === 'querySelectorAll') return v;
    if (m === 'getElementsByClassName') return `.${v}`;
    return undefined;
  }

  function collectUnreachable(stmts: t.Statement[]): void {
    let jumped: string | null = null;
    for (const s of stmts) {
      if (jumped) {
        if (t.isFunctionDeclaration(s) || (t.isVariableDeclaration(s) && s.kind === 'var') || t.isEmptyStatement(s)) continue;
        unreachable.push({ file, loc: loc(s), reason: `unreachable after ${jumped}` });
        break;
      }
      if (t.isReturnStatement(s)) jumped = 'return';
      else if (t.isThrowStatement(s)) jumped = 'throw';
      else if (t.isBreakStatement(s)) jumped = 'break';
      else if (t.isContinueStatement(s)) jumped = 'continue';
    }
  }

  // Second pass for element targets: `const btn = document.getElementById('open')` -> btn => #open
  // (done after scopes exist so bindings are resolvable; event wiring above reads the map lazily
  // for later statements only when the declaration precedes use, so re-run event resolution here).
  traverse(ast, {
    VariableDeclarator(path) {
      const init = path.node.init ? (t.isAwaitExpression(path.node.init) ? path.node.init.argument : path.node.init) : null;
      if (init && t.isCallExpression(init) && t.isIdentifier(path.node.id)) {
        const target = domTargetOf(init);
        const b = path.scope.getBinding(path.node.id.name);
        if (target && b) elementTargets.set(b, target);
      }
    },
  });
  // Re-resolve event targets that were visited before their element variable was registered.
  traverse(ast, {
    CallExpression(path) {
      const n = path.node;
      if (t.isMemberExpression(n.callee) && t.isIdentifier(n.callee.property, { name: 'addEventListener' }) && t.isIdentifier(n.callee.object)) {
        const b = path.scope.getBinding(n.callee.object.name);
        const target = b ? elementTargets.get(b) : undefined;
        if (!target) return;
        const ev = literalOf(n.arguments[0]);
        const ref = domRefs.find((r) => r.kind === 'event' && r.event === ev && r.loc.line === (n.loc?.start.line ?? 0) && !r.target);
        if (ref) ref.target = target;
      }
    },
  });

  const moduleInfo = {
    file,
    isModule,
    imports,
    exports: exportsList,
  };
  // CommonJS exports
  traverse(ast, {
    AssignmentExpression(path) {
      const l = path.node.left;
      if (t.isMemberExpression(l) && isCommonJsExportTarget(l) && !path.scope.hasBinding('module') && !path.scope.hasBinding('exports')) {
        let name = 'default';
        if (t.isMemberExpression(l) && t.isIdentifier(l.object, { name: 'exports' }) && t.isIdentifier(l.property)) name = l.property.name;
        else if (t.isMemberExpression(l.object) && isModuleExportsChain(l.object) && t.isIdentifier(l.property)) name = l.property.name;
        exportsList.push({ name, kind: 'commonjs', loc: loc(path.node) });
      }
    },
  });

  return {
    file,
    language,
    variables,
    functions,
    module: moduleInfo,
    dataFlow,
    calls,
    domRefs,
    unreachable,
    strings,
    functionHashes,
    hasDynamicScope,
    identifierCounts: { ...identifierCounts },
  };
}
