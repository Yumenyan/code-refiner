import type { SyntaxNode } from './runtime.js';

/** How one parser-backed language declares variables, calls things and writes lambdas. */
export interface CallShape {
  /** Receiver of `receiver.method(...)`, or null for a plain call. */
  object: SyntaxNode | null;
  method: string;
  args: SyntaxNode[];
}

export interface LambdaShape {
  params: SyntaxNode[];
  body: SyntaxNode | null;
}

export interface Decl {
  id: SyntaxNode;
  kind: 'local' | 'param' | 'loop' | 'closure';
  /** Initializer expression (`let x = <init>`). */
  init?: SyntaxNode | null;
  /** Iterated expression (`for x in <over>`). */
  over?: SyntaxNode | null;
}

export interface LangAdapter {
  id: string;
  /** Snake or camel case for names the tool creates. */
  casing: 'snake' | 'camel';
  /** Node types that are functions / methods / constructors (lambdas are handled inside their function). */
  functionTypes: Set<string>;
  /** Leaf types that name a variable (field / type / method names have other types). */
  identifierTypes: Set<string>;
  reserved: Set<string>;
  decls(fn: SyntaxNode): Decl[];
  callShape(n: SyntaxNode): CallShape | null;
  lambdaShape(n: SyntaxNode): LambdaShape | null;
  /** A member read on an object: `obj.prop` / `obj.getProp()`. */
  member(n: SyntaxNode): { object: SyntaxNode; name: string } | null;
  /** Identifier positions that do not refer to a variable (method names, keyword arguments, paths ...). */
  ambiguous(id: SyntaxNode): boolean;
  /** Strings are searched for `{name}` captures (Rust format args, Python f-strings). */
  formatCaptures: boolean;
  pushMethods: Set<string>;
  literalType(init: SyntaxNode): 'array' | 'number' | 'string' | 'boolean' | 'object' | undefined;
}

const named = (n: SyntaxNode | null | undefined) => (n ? n.namedChildren.filter((c) => !/comment/.test(c.type)) : []);
const f = (n: SyntaxNode, name: string) => n.childForFieldName(name);

function ancestor(n: SyntaxNode, test: (a: SyntaxNode) => boolean, stopAt?: (a: SyntaxNode) => boolean): SyntaxNode | null {
  for (let p = n.parent; p; p = p.parent) {
    if (test(p)) return p;
    if (stopAt?.(p)) return null;
  }
  return null;
}

function descend(n: SyntaxNode, fn: (c: SyntaxNode) => void): void {
  fn(n);
  for (let i = 0; i < n.childCount; i++) descend(n.child(i)!, fn);
}

/** Identifiers bound by a pattern (`mut x`, `&x`, `(a, b)` ...), skipping paths and constructor names. */
function patternIdentifiers(p: SyntaxNode | null | undefined, skipFields: string[] = ['type', 'name', 'path']): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  if (!p) return out;
  const walk = (n: SyntaxNode, fieldName: string | null): void => {
    if (n.type === 'identifier') {
      if (!(fieldName && skipFields.includes(fieldName))) out.push(n);
      return;
    }
    if (/scoped_identifier|type_identifier|field_identifier|shorthand_field/.test(n.type)) return;
    for (let i = 0; i < n.childCount; i++) walk(n.child(i)!, n.fieldNameForChild(i));
  };
  walk(p, null);
  return out;
}

// ---- Rust ---------------------------------------------------------------------------------------
const RUST_KW = 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while abstract become box do final macro override priv typeof unsized virtual yield try union'.split(' ');
const KNOWN_MACROS = new Set(['println', 'print', 'eprintln', 'eprint', 'format', 'vec', 'assert', 'assert_eq', 'assert_ne', 'debug_assert', 'write', 'writeln', 'panic', 'dbg', 'todo', 'unimplemented', 'matches']);

export const rustAdapter: LangAdapter = {
  id: 'rust',
  casing: 'snake',
  functionTypes: new Set(['function_item']),
  identifierTypes: new Set(['identifier']),
  reserved: new Set(RUST_KW),
  formatCaptures: true,
  pushMethods: new Set(['push', 'push_back', 'insert']),
  decls(fn) {
    const out: Decl[] = [];
    descend(fn, (n) => {
      if (n.type === 'let_declaration') {
        const pat = f(n, 'pattern');
        const ids = patternIdentifiers(pat);
        const simple = pat && (pat.type === 'identifier' || (pat.type === 'mut_pattern' && ids.length === 1));
        for (const id of ids) out.push({ id, kind: 'local', init: simple ? f(n, 'value') : undefined });
      } else if (n.type === 'parameter') {
        for (const id of patternIdentifiers(f(n, 'pattern'))) out.push({ id, kind: 'param' });
      } else if (n.type === 'closure_parameters') {
        for (const c of named(n)) {
          if (c.type === 'parameter') for (const id of patternIdentifiers(f(c, 'pattern'))) out.push({ id, kind: 'closure' });
          else for (const id of patternIdentifiers(c)) out.push({ id, kind: 'closure' });
        }
      } else if (n.type === 'for_expression') {
        const ids = patternIdentifiers(f(n, 'pattern'));
        const pat = f(n, 'pattern');
        for (const id of ids) out.push({ id, kind: 'loop', over: pat && (pat.type === 'identifier' || pat.type === 'reference_pattern' || pat.type === 'mut_pattern') ? f(n, 'value') : undefined });
      } else if (n.type === 'let_condition' || n.type === 'match_pattern' || n.type === 'self_parameter') {
        for (const id of patternIdentifiers(n.type === 'let_condition' ? f(n, 'pattern') : n)) out.push({ id, kind: 'local' });
      }
    });
    return out;
  },
  callShape(n) {
    if (n.type !== 'call_expression') return null;
    let fn = f(n, 'function');
    if (fn?.type === 'generic_function') fn = f(fn, 'function'); // collect::<Vec<_>>()
    const args = named(f(n, 'arguments'));
    if (fn?.type === 'field_expression') return { object: f(fn, 'value'), method: f(fn, 'field')?.text ?? '', args };
    if (fn?.type === 'identifier') return { object: null, method: fn.text, args };
    return null;
  },
  lambdaShape(n) {
    if (n.type !== 'closure_expression') return null;
    const ps = f(n, 'parameters');
    const params: SyntaxNode[] = [];
    for (const c of named(ps)) {
      if (c.type === 'parameter') params.push(...patternIdentifiers(f(c, 'pattern')));
      else params.push(...patternIdentifiers(c));
    }
    return { params, body: f(n, 'body') };
  },
  member(n) {
    if (n.type === 'field_expression') {
      const v = f(n, 'value');
      const name = f(n, 'field')?.text;
      return v && name ? { object: v, name } : null;
    }
    return null;
  },
  ambiguous(id) {
    const p = id.parent;
    if (!p) return false;
    if (/scoped_identifier|shorthand_field_initializer|attribute|use_|meta_item/.test(p.type)) return true;
    if (p.type === 'tuple_struct_pattern' && f(p, 'type')?.id === id.id) return true;
    if (p.type === 'call_expression' && f(p, 'function')?.id === id.id) {
      // calling something: a local closure is fine, a function item with the same name is not -> be careful
      return false;
    }
    const mac = ancestor(id, (a) => a.type === 'macro_invocation');
    if (mac) {
      const name = f(mac, 'macro')?.text ?? '';
      if (!KNOWN_MACROS.has(name.replace(/^.*::/, ''))) return true;
    }
    return /^(token_tree|macro_rule)/.test(p.type) && !mac;
  },
  literalType(init) {
    const t = init.type;
    if (t === 'macro_invocation' && /^vec$/.test(f(init, 'macro')?.text ?? '')) return 'array';
    if (t === 'array_expression') return 'array';
    if (t === 'integer_literal' || t === 'float_literal') return 'number';
    if (t === 'string_literal' || t === 'raw_string_literal') return 'string';
    if (t === 'boolean_literal') return 'boolean';
    if (t === 'call_expression') {
      const fn = f(init, 'function');
      if (fn?.type === 'scoped_identifier' && /^(Vec|VecDeque)::(new|with_capacity|from)$/.test(fn.text)) return 'array';
      if (fn?.type === 'scoped_identifier' && /^(HashMap|BTreeMap|HashSet|BTreeSet)::/.test(fn.text)) return 'object';
      if (fn?.type === 'scoped_identifier' && /^String::(new|from)$/.test(fn.text)) return 'string';
    }
    return undefined;
  },
};

// ---- Java ---------------------------------------------------------------------------------------
const JAVA_KW = 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null var record yield sealed permits'.split(' ');

export const javaAdapter: LangAdapter = {
  id: 'java',
  casing: 'camel',
  functionTypes: new Set(['method_declaration', 'constructor_declaration']),
  identifierTypes: new Set(['identifier']),
  reserved: new Set(JAVA_KW),
  formatCaptures: false,
  pushMethods: new Set(['add', 'addLast', 'offer']),
  decls(fn) {
    const out: Decl[] = [];
    descend(fn, (n) => {
      if (n.type === 'local_variable_declaration') {
        for (const d of n.namedChildren.filter((c) => c.type === 'variable_declarator')) {
          const id = f(d, 'name');
          if (id?.type === 'identifier') out.push({ id, kind: 'local', init: f(d, 'value') });
        }
      } else if (n.type === 'formal_parameter' || n.type === 'spread_parameter') {
        const id = f(n, 'name') ?? n.namedChildren.find((c) => c.type === 'variable_declarator')?.childForFieldName('name');
        if (id?.type === 'identifier') out.push({ id, kind: 'param' });
      } else if (n.type === 'catch_formal_parameter') {
        const id = f(n, 'name');
        if (id) out.push({ id, kind: 'local' });
      } else if (n.type === 'enhanced_for_statement') {
        const id = f(n, 'name');
        if (id) out.push({ id, kind: 'loop', over: f(n, 'value') });
      } else if (n.type === 'lambda_expression') {
        const ps = f(n, 'parameters');
        if (ps?.type === 'identifier') out.push({ id: ps, kind: 'closure' });
        else for (const c of named(ps)) {
          if (c.type === 'identifier') out.push({ id: c, kind: 'closure' });
          else if (c.type === 'formal_parameter') { const id = f(c, 'name'); if (id) out.push({ id, kind: 'closure' }); }
        }
      }
    });
    return out;
  },
  callShape(n) {
    if (n.type !== 'method_invocation') return null;
    return { object: f(n, 'object'), method: f(n, 'name')?.text ?? '', args: named(f(n, 'arguments')) };
  },
  lambdaShape(n) {
    if (n.type !== 'lambda_expression') return null;
    const ps = f(n, 'parameters');
    const params = ps?.type === 'identifier' ? [ps] : named(ps).flatMap((c) => (c.type === 'identifier' ? [c] : c.type === 'formal_parameter' ? [f(c, 'name')!].filter(Boolean) : []));
    return { params, body: f(n, 'body') };
  },
  member(n) {
    if (n.type === 'field_access') {
      const o = f(n, 'object');
      const name = f(n, 'field')?.text;
      return o && name ? { object: o, name } : null;
    }
    if (n.type === 'method_invocation') {
      const o = f(n, 'object');
      const m = f(n, 'name')?.text;
      if (o && m && named(f(n, 'arguments')).length === 0 && /^(get|is|has)[A-Z]/.test(m)) return { object: o, name: m.replace(/^(get|is|has)/, '').replace(/^[A-Z]/, (c) => c.toLowerCase()) };
    }
    return null;
  },
  ambiguous(id) {
    const p = id.parent;
    if (!p) return false;
    if (p.type === 'method_invocation' && f(p, 'name')?.id === id.id) return true;
    if (p.type === 'field_access' && f(p, 'field')?.id === id.id) return true;
    if (/scoped_identifier|method_reference|element_value_pair|labeled_statement|annotation|marker_annotation|import_declaration|package_declaration/.test(p.type)) return true;
    return false;
  },
  literalType(init) {
    const t = init.type;
    if (t === 'array_creation_expression' || t === 'array_initializer') return 'array';
    if (t === 'object_creation_expression') return /^(ArrayList|LinkedList|List|Vector)/.test(f(init, 'type')?.text ?? '') ? 'array' : /^(HashMap|Map|HashSet|Set|TreeMap)/.test(f(init, 'type')?.text ?? '') ? 'object' : undefined;
    if (/^(decimal_integer_literal|hex_integer_literal|decimal_floating_point_literal)$/.test(t)) return 'number';
    if (t === 'string_literal') return 'string';
    if (t === 'true' || t === 'false') return 'boolean';
    return undefined;
  },
};

// ---- C# -----------------------------------------------------------------------------------------
const CS_KW = 'abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while var async await yield record'.split(' ');

export const csharpAdapter: LangAdapter = {
  id: 'csharp',
  casing: 'camel',
  functionTypes: new Set(['method_declaration', 'constructor_declaration', 'local_function_statement']),
  identifierTypes: new Set(['identifier']),
  reserved: new Set(CS_KW),
  formatCaptures: false,
  pushMethods: new Set(['Add', 'Enqueue', 'Push']),
  decls(fn) {
    const out: Decl[] = [];
    descend(fn, (n) => {
      if (n.type === 'variable_declarator') {
        const id = f(n, 'name') ?? n.namedChildren.find((c) => c.type === 'identifier');
        const decl = n.parent?.parent;
        if (id?.type === 'identifier' && decl && /local_declaration_statement|variable_declaration|using_statement/.test(decl.type + (n.parent?.type ?? ''))) {
          const init = n.namedChildren.find((c) => c.type === 'equals_value_clause')?.namedChildren[0] ?? f(n, 'value');
          out.push({ id, kind: 'local', init: init ?? null });
        }
      } else if (n.type === 'parameter') {
        const id = f(n, 'name');
        if (id) out.push({ id, kind: 'param' });
      } else if (n.type === 'foreach_statement' || n.type === 'for_each_statement') {
        const id = f(n, 'left');
        if (id?.type === 'identifier') out.push({ id, kind: 'loop', over: f(n, 'right') });
      } else if (n.type === 'lambda_expression') {
        const ps = f(n, 'parameters') ?? n.namedChildren[0];
        if (ps?.type === 'identifier') out.push({ id: ps, kind: 'closure' });
        else for (const c of named(ps)) if (c.type === 'parameter') { const id = f(c, 'name'); if (id) out.push({ id, kind: 'closure' }); } else if (c.type === 'identifier') out.push({ id: c, kind: 'closure' });
      }
    });
    return out;
  },
  callShape(n) {
    if (n.type !== 'invocation_expression') return null;
    const fn = f(n, 'function');
    const args = named(f(n, 'arguments')).map((a) => (a.type === 'argument' ? a.namedChildren[0] ?? a : a));
    if (fn?.type === 'member_access_expression') return { object: f(fn, 'expression'), method: f(fn, 'name')?.text ?? '', args };
    if (fn?.type === 'identifier') return { object: null, method: fn.text, args };
    return null;
  },
  lambdaShape(n) {
    if (n.type !== 'lambda_expression') return null;
    const ps = f(n, 'parameters') ?? n.namedChildren[0];
    const params = ps?.type === 'identifier' ? [ps] : named(ps).flatMap((c) => (c.type === 'identifier' ? [c] : c.type === 'parameter' ? [f(c, 'name')!].filter(Boolean) : []));
    return { params, body: f(n, 'body') };
  },
  member(n) {
    if (n.type === 'member_access_expression') {
      const o = f(n, 'expression');
      const name = f(n, 'name')?.text;
      return o && name ? { object: o, name: name.replace(/^[A-Z]/, (c) => c.toLowerCase()) } : null;
    }
    return null;
  },
  ambiguous(id) {
    const p = id.parent;
    if (!p) return false;
    if (p.type === 'member_access_expression' && f(p, 'name')?.id === id.id) return true;
    if (p.type === 'invocation_expression' && f(p, 'function')?.id === id.id) return true;
    if (/qualified_name|name_colon|attribute|using_directive|label|alias_qualified/.test(p.type)) return true;
    return false;
  },
  literalType(init) {
    const t = init.type;
    if (t === 'array_creation_expression' || t === 'implicit_array_creation_expression' || t === 'initializer_expression') return 'array';
    if (t === 'object_creation_expression') return /^(List|IList|Queue|Stack)/.test(f(init, 'type')?.text ?? '') ? 'array' : /^(Dictionary|HashSet)/.test(f(init, 'type')?.text ?? '') ? 'object' : undefined;
    if (t === 'integer_literal' || t === 'real_literal') return 'number';
    if (t === 'string_literal' || t === 'verbatim_string_literal') return 'string';
    if (t === 'boolean_literal') return 'boolean';
    return undefined;
  },
};

// ---- Go -----------------------------------------------------------------------------------------
const GO_KW = 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil iota'.split(' ');

export const goAdapter: LangAdapter = {
  id: 'go',
  casing: 'camel',
  functionTypes: new Set(['function_declaration', 'method_declaration']),
  identifierTypes: new Set(['identifier']),
  reserved: new Set(GO_KW),
  formatCaptures: false,
  pushMethods: new Set([]),
  decls(fn) {
    const out: Decl[] = [];
    descend(fn, (n) => {
      if (n.type === 'short_var_declaration') {
        const left = named(f(n, 'left'));
        const right = named(f(n, 'right'));
        left.forEach((id, i) => {
          if (id.type === 'identifier') out.push({ id, kind: 'local', init: left.length === right.length ? right[i] : undefined });
        });
      } else if (n.type === 'var_spec') {
        const ids = n.namedChildren.filter((c) => c.type === 'identifier');
        const values = named(f(n, 'value'));
        ids.forEach((id, i) => out.push({ id, kind: 'local', init: ids.length === values.length ? values[i] : undefined }));
      } else if (n.type === 'parameter_declaration' || n.type === 'variadic_parameter_declaration') {
        for (const id of n.namedChildren.filter((c) => c.type === 'identifier' && f(n, 'type')?.id !== c.id)) out.push({ id, kind: 'param' });
      } else if (n.type === 'range_clause') {
        const left = named(f(n, 'left'));
        left.forEach((id, i) => {
          if (id.type === 'identifier' && id.text !== '_') out.push({ id, kind: 'loop', over: left.length === 1 || i === left.length - 1 ? f(n, 'right') : undefined });
        });
      }
    });
    return out;
  },
  callShape(n) {
    if (n.type !== 'call_expression') return null;
    const fn = f(n, 'function');
    const args = named(f(n, 'arguments'));
    if (fn?.type === 'selector_expression') return { object: f(fn, 'operand'), method: f(fn, 'field')?.text ?? '', args };
    if (fn?.type === 'identifier') return { object: null, method: fn.text, args };
    return null;
  },
  lambdaShape(n) {
    if (n.type !== 'func_literal') return null;
    const params = named(f(n, 'parameters')).flatMap((c) => c.namedChildren.filter((x) => x.type === 'identifier' && f(c, 'type')?.id !== x.id));
    return { params, body: f(n, 'body') };
  },
  member(n) {
    if (n.type === 'selector_expression') {
      const o = f(n, 'operand');
      const name = f(n, 'field')?.text;
      return o && name ? { object: o, name: name.replace(/^[A-Z]/, (c) => c.toLowerCase()) } : null;
    }
    return null;
  },
  ambiguous(id) {
    const p = id.parent;
    if (!p) return false;
    if (/keyed_element|literal_element|labeled_statement|label_name|import|package/.test(p.type)) return true;
    if (p.parent && p.parent.type === 'keyed_element') return true;
    return false;
  },
  literalType(init) {
    const t = init.type;
    if (t === 'composite_literal') return /^\[\]/.test(f(init, 'type')?.text ?? '') ? 'array' : /^map\[/.test(f(init, 'type')?.text ?? '') ? 'object' : undefined;
    if (t === 'int_literal' || t === 'float_literal') return 'number';
    if (t === 'interpreted_string_literal' || t === 'raw_string_literal') return 'string';
    if (t === 'true' || t === 'false') return 'boolean';
    return undefined;
  },
};

// ---- Python -------------------------------------------------------------------------------------
const PY_KW = 'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self cls'.split(' ');

export const pythonAdapter: LangAdapter = {
  id: 'python',
  casing: 'snake',
  functionTypes: new Set(['function_definition']),
  identifierTypes: new Set(['identifier']),
  reserved: new Set(PY_KW),
  formatCaptures: true,
  pushMethods: new Set(['append', 'add']),
  decls(fn) {
    const out: Decl[] = [];
    const walk = (n: SyntaxNode): void => {
      if (n.type === 'assignment') {
        const left = f(n, 'left');
        if (left?.type === 'identifier') out.push({ id: left, kind: 'local', init: f(n, 'right') });
        else if (left) for (const id of patternIdentifiers(left)) out.push({ id, kind: 'local' });
      } else if (n.type === 'augmented_assignment') {
        // not a new binding
      } else if (n.type === 'parameters' || n.type === 'lambda_parameters') {
        for (const c of named(n)) {
          if (c.type === 'identifier') out.push({ id: c, kind: n.type === 'lambda_parameters' ? 'closure' : 'param' });
          else if (c.type === 'default_parameter' || c.type === 'typed_parameter' || c.type === 'typed_default_parameter') {
            const id = f(c, 'name') ?? c.namedChildren.find((x) => x.type === 'identifier');
            if (id?.type === 'identifier') out.push({ id, kind: 'param' });
          }
        }
      } else if (n.type === 'for_statement' || n.type === 'for_in_clause') {
        const left = f(n, 'left');
        if (left?.type === 'identifier') out.push({ id: left, kind: 'loop', over: f(n, 'right') });
        else if (left) for (const id of patternIdentifiers(left)) out.push({ id, kind: 'loop' });
      } else if (n.type === 'as_pattern' || n.type === 'named_expression') {
        const id = n.namedChildren.find((x) => x.type === 'as_pattern_target' || x.type === 'identifier');
        const t = id?.type === 'as_pattern_target' ? id.namedChildren[0] : id;
        if (t?.type === 'identifier' && n.type === 'as_pattern') out.push({ id: t, kind: 'local' });
      }
      for (let i = 0; i < n.childCount; i++) walk(n.child(i)!);
    };
    walk(fn);
    return out;
  },
  callShape(n) {
    if (n.type !== 'call') return null;
    const fn = f(n, 'function');
    const args = named(f(n, 'arguments'));
    if (fn?.type === 'attribute') return { object: f(fn, 'object'), method: f(fn, 'attribute')?.text ?? '', args };
    if (fn?.type === 'identifier') return { object: null, method: fn.text, args };
    return null;
  },
  lambdaShape(n) {
    if (n.type !== 'lambda') return null;
    const ps = f(n, 'parameters');
    return { params: named(ps).filter((c) => c.type === 'identifier'), body: f(n, 'body') };
  },
  member(n) {
    if (n.type === 'attribute') {
      const o = f(n, 'object');
      const name = f(n, 'attribute')?.text;
      return o && name ? { object: o, name } : null;
    }
    return null;
  },
  ambiguous(id) {
    const p = id.parent;
    if (!p) return false;
    if (p.type === 'keyword_argument' && f(p, 'name')?.id === id.id) return true;
    if (p.type === 'attribute' && f(p, 'attribute')?.id === id.id) return true;
    if ((p.type === 'function_definition' || p.type === 'class_definition') && f(p, 'name')?.id === id.id) return true;
    if (/import|dotted_name|decorator|global_statement|nonlocal_statement/.test(p.type)) return true;
    return !!ancestor(id, (a) => /import_statement|import_from_statement|global_statement|nonlocal_statement|decorator/.test(a.type));
  },
  literalType(init) {
    const t = init.type;
    if (t === 'list' || t === 'list_comprehension' || t === 'tuple') return 'array';
    if (t === 'dictionary' || t === 'set' || t === 'dictionary_comprehension') return 'object';
    if (t === 'integer' || t === 'float') return 'number';
    if (t === 'string' || t === 'concatenated_string') return 'string';
    if (t === 'true' || t === 'false') return 'boolean';
    return undefined;
  },
};

export const ADAPTERS: Record<string, LangAdapter> = {
  rust: rustAdapter,
  java: javaAdapter,
  csharp: csharpAdapter,
  go: goAdapter,
  python: pythonAdapter,
};
