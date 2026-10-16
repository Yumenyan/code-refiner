/** Identifier word utilities: splitting, casing, simple English inflection. */

export type Casing = 'camel' | 'snake' | 'pascal' | 'upper-snake' | 'kebab' | 'lower' | 'unknown';

export function splitWords(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-$\s]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export function detectCasing(name: string): Casing {
  if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(name) || /^[A-Z0-9]{2,}$/.test(name)) return 'upper-snake';
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(name)) return 'snake';
  if (/^[a-z]+(-[a-z0-9]+)+$/.test(name)) return 'kebab';
  if (/^[A-Z][a-z0-9]+([A-Z][a-z0-9]*)*$/.test(name)) return 'pascal';
  if (/^[a-z][a-z0-9]*([A-Z][a-z0-9]*)+$/.test(name)) return 'camel';
  if (/^[a-z][a-z0-9]*$/.test(name)) return 'lower';
  return 'unknown';
}

const cap = (w: string) => (w ? w[0].toUpperCase() + w.slice(1) : w);

export function joinWords(words: string[], casing: 'camel' | 'snake' | 'pascal' = 'camel'): string {
  const ws = words.filter(Boolean).map((w) => w.toLowerCase());
  if (ws.length === 0) return '';
  if (casing === 'snake') return ws.join('_');
  if (casing === 'pascal') return ws.map(cap).join('');
  return ws[0] + ws.slice(1).map(cap).join('');
}

const IRREGULAR_PLURAL: Record<string, string> = {
  person: 'people', child: 'children', man: 'men', woman: 'women', foot: 'feet', tooth: 'teeth',
  mouse: 'mice', goose: 'geese', datum: 'data', index: 'indices', vertex: 'vertices',
  matrix: 'matrices', criterion: 'criteria', analysis: 'analyses', axis: 'axes',
};
const IRREGULAR_SINGULAR: Record<string, string> = Object.fromEntries(
  Object.entries(IRREGULAR_PLURAL).map(([s, p]) => [p, s]),
);
const UNCOUNTABLE = new Set([
  'data', 'info', 'information', 'news', 'series', 'species', 'money', 'equipment', 'metadata',
  'status', 'bus', 'class', 'address', 'process', 'access', 'progress', 'success', 'canvas', 'alias',
  'analysis', 'basis', 'css', 'js', 'ts', 'this', 'is', 'has', 'was', 'yes', 'less', 'plus', 'gas', 'lens',
]);

export function singularize(word: string): string {
  const w = word.toLowerCase();
  if (UNCOUNTABLE.has(w) && w !== 'data') return w;
  if (IRREGULAR_SINGULAR[w]) return IRREGULAR_SINGULAR[w];
  if (w === 'data') return 'datum';
  if (w.length <= 2) return w;
  if (/[^aeiou]ies$/.test(w)) return w.slice(0, -3) + 'y';
  if (/(ch|sh|ss|x|z)es$/.test(w)) return w.slice(0, -2);
  if (/(ses|xes|zes)$/.test(w)) return w.slice(0, -2);
  if (/[^aeiou]oes$/.test(w) && w.length > 4) return w.slice(0, -2);
  if (/ves$/.test(w) && w.length > 4) return w.slice(0, -3) + 'f';
  if (/(ss|us|is)$/.test(w)) return w;
  if (w.endsWith('s')) return w.slice(0, -1);
  return w;
}

export function pluralize(word: string): string {
  const w = word.toLowerCase();
  if (IRREGULAR_PLURAL[w]) return IRREGULAR_PLURAL[w];
  if (UNCOUNTABLE.has(w)) return w;
  if (/[^aeiou]y$/.test(w)) return w.slice(0, -1) + 'ies';
  if (/(s|x|z|ch|sh)$/.test(w)) return w + 'es';
  return w + 's';
}

/** Heuristic: does this word look plural? */
export function looksPlural(word: string): boolean {
  const w = word.toLowerCase();
  if (UNCOUNTABLE.has(w) && w !== 'data') return false;
  if (IRREGULAR_SINGULAR[w]) return true;
  if (w === 'data') return true;
  return w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w);
}

export const RESERVED_WORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
  'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof',
  'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void',
  'while', 'with', 'yield', 'let', 'static', 'implements', 'interface', 'package', 'private', 'protected',
  'public', 'await', 'async', 'arguments', 'eval', 'undefined', 'NaN', 'Infinity', 'of', 'type', 'as',
]);

export function isValidIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !RESERVED_WORDS.has(name);
}

/** Names that carry (almost) no meaning on their own. */
const GENERIC_NAMES = new Set([
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  'tmp', 'temp', 'tmp1', 'tmp2', 'temp1', 'temp2', 'foo', 'bar', 'baz', 'val', 'var1', 'var2', 'obj', 'arr', 'ret',
  'res', 'rs', 'dat', 'd1', 'd2', 'x1', 'x2', 'y1', 'y2', 'o1', 'o2', 'a1', 'a2', 'v1', 'v2', 'item1', 'item2',
  'data', 'result', 'results', 'value', 'values', 'list', 'items', 'item', 'thing', 'stuff', 'info', 'elem', 'el',
  'node', 'arg', 'args', 'param', 'params', 'cb', 'fn', 'func', 'f1', 'f2', 'flag', 'str', 'num', 'cnt', 'idx',
]);

/** Names that are poor enough that we try to find better ones. Loop counters are exempt. */
export function isPoorName(name: string): boolean {
  if (name === '_' || name === '$' || /^_+$/.test(name)) return false;
  if (/^[ijk]$/.test(name)) return false; // conventional loop indices; handled by caller context
  return GENERIC_NAMES.has(name.toLowerCase()) || /^[a-z]\d*$/i.test(name) || /^(tmp|temp|var|v|x|y|a|b)\d+$/i.test(name);
}

/** Names that are too ambiguous to be proposed as an improvement. */
export function isAmbiguousName(name: string): boolean {
  const words = splitWords(name);
  return words.length === 1 && GENERIC_NAMES.has(words[0]);
}

export const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'get', 'set', 'is', 'has', 'on', 'of', 'to', 'in', 'by',
  'new', 'old', 'tmp', 'temp', 'fn', 'cb', 'obj', 'arr', 'val', 'var', 'str', 'num', 'idx', 'res', 'ret',
  'err', 'error', 'e', 'i', 'j', 'k', 'x', 'y', 'z', 'a', 'b', 'c', 'd', 'n', 'm', 's', 't', 'el', 'evt', 'ev',
  'data', 'item', 'items', 'value', 'values', 'list', 'result', 'results', 'args', 'arg', 'params', 'param',
  'function', 'return', 'const', 'let', 'if', 'else', 'true', 'false', 'null', 'undefined', 'index', 'key', 'keys',
  'length', 'count', 'total', 'name', 'type', 'id', 'text', 'node', 'element', 'handler', 'callback', 'init',
  'main', 'run', 'update', 'render', 'load', 'start', 'stop', 'on', 'off', 'add', 'remove', 'create', 'delete',
  'click', 'change', 'event', 'window', 'document', 'console', 'math', 'json', 'array', 'object', 'string', 'number',
  'map', 'filter', 'reduce', 'find', 'sort', 'push', 'pop', 'then', 'catch', 'await', 'async', 'default', 'module',
  'export', 'import', 'require', 'class', 'props', 'state', 'ref', 'self', 'that', 'app', 'utils', 'util', 'helper',
]);
