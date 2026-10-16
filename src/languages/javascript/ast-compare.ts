import type { Node } from '@babel/types';

const IGNORED_KEYS = new Set([
  'loc', 'start', 'end', 'range', 'extra', 'comments', 'leadingComments', 'trailingComments',
  'innerComments', 'tokens', 'errors', 'original', 'raw', 'directives_', '__clone',
]);

/**
 * A canonical, location-free view of an AST used to prove that cosmetic changes
 * (formatting, parentheses, quote style, property-key quoting) did not alter meaning.
 */
export function canonicalize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(canonicalize);
  if (node === null || typeof node !== 'object') return node;
  const n = node as Record<string, unknown>;
  const type = n.type as string | undefined;
  if (!type) return n;

  // `{ 'a': 1 }` and `{ a: 1 }` are the same.
  if ((type === 'ObjectProperty' || type === 'ObjectMethod' || type === 'ClassProperty' || type === 'ClassMethod') && n.computed === false) {
    const key = n.key as Record<string, unknown>;
    const name = key.type === 'Identifier' ? key.name : key.type === 'StringLiteral' ? key.value : key.type === 'NumericLiteral' ? String(key.value) : undefined;
    if (name !== undefined) {
      const out: Record<string, unknown> = { type };
      for (const [k, v] of Object.entries(n)) {
        if (IGNORED_KEYS.has(k) || k === 'key' || k === 'shorthand') continue;
        out[k] = canonicalize(v);
      }
      out.key = { type: 'Key', name: String(name) };
      return out;
    }
  }
  if (type === 'NumericLiteral') return { type, value: n.value };
  if (type === 'BigIntLiteral') return { type, value: n.value };
  if (type === 'DirectiveLiteral' || type === 'StringLiteral') return { type: 'StringLiteral', value: n.value };
  if (type === 'TemplateElement') return { type, cooked: (n.value as { cooked?: string }).cooked };

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n)) {
    if (IGNORED_KEYS.has(k)) continue;
    out[k] = canonicalize(v);
  }
  return out;
}

export function sameAst(a: Node, b: Node): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}
