import type { NamingWeights } from '../core/config.js';
import type { NamingConvention } from './convention.js';
import type { Fact, NamingSubject, ValueType } from './facts.js';
import { joinWords, looksPlural, pluralize, singularize, splitWords } from './words.js';

export type Role = 'collection' | 'item' | 'scalar' | 'count' | 'boolean' | 'element' | 'elements' | 'function';

export interface Evidence {
  key: keyof NamingWeights;
  note: string;
}

export interface NameSpec {
  pre: string[];
  head: string[];
  post: string[];
  /** Pluralise the final word (collections). */
  plural: boolean;
  role: Role;
  evidence: Evidence[];
}

const ELEMENT_SUFFIX = new Set([
  'button', 'btn', 'input', 'form', 'list', 'container', 'modal', 'panel', 'menu', 'select', 'label', 'link',
  'image', 'img', 'canvas', 'table', 'dialog', 'header', 'footer', 'nav', 'wrapper', 'box', 'field', 'tab',
]);
const ELEMENT_ALIASES: Record<string, string> = { btn: 'button', img: 'image' };
const AVAILABILITY_PROPS = new Set(['active', 'enabled', 'available', 'visible', 'open', 'online', 'valid']);

const sing = (words: string[]): string[] => (words.length ? [...words.slice(0, -1), singularize(words[words.length - 1])] : words);

function asAdjective(prop: string): { pre: string[]; post: string[] } | null {
  const ws = splitWords(prop);
  if (ws.length === 0) return null;
  if (ws[0] === 'is' && ws.length > 1) return { pre: ws.slice(1), post: [] };
  if (ws[0] === 'has' && ws.length > 1) return { pre: [], post: ['with', ...ws.slice(1)] };
  if (['length', 'size', 'count', 'id', 'key', 'index', 'name', 'type', 'value'].includes(ws[ws.length - 1]) && ws.length === 1) return null;
  return { pre: ws, post: [] };
}

function find<T extends Fact['type']>(facts: Fact[], type: T): Extract<Fact, { type: T }> | undefined {
  return facts.find((f) => f.type === type) as Extract<Fact, { type: T }> | undefined;
}
function all<T extends Fact['type']>(facts: Fact[], type: T): Extract<Fact, { type: T }>[] {
  return facts.filter((f) => f.type === type) as Extract<Fact, { type: T }>[];
}

/** Generates structural name candidates from facts. Rendering and scoring happen later. */
export function generateSpecs(subject: NamingSubject): NameSpec[] {
  const out: NameSpec[] = [];
  const facts = subject.facts;
  const source = find(facts, 'source');
  const method = find(facts, 'method');
  const call = find(facts, 'call');
  const dom = find(facts, 'dom');
  const elementOf = find(facts, 'element-of');
  const callsite = find(facts, 'callsite');
  const props = all(facts, 'property');
  const usages = all(facts, 'usage');
  const vtype = subject.valueType;
  const typeNote = (extra = '') => ({ key: 'typeMatch' as const, note: `value is ${vtype}${extra}` });

  const push = (s: Omit<NameSpec, 'evidence'> & { evidence?: Evidence[] }) => out.push({ evidence: [], ...s });

  // --- Values derived from a collection by a method ---------------------------------------
  if (source && method) {
    const head = sing(source.words);
    const srcEv: Evidence = { key: 'sourceMatch', note: `derived from "${source.words.join(' ')}"` };
    const mEv: Evidence = { key: 'methodMatch', note: `.${method.name}()` };
    const tEv = typeNote();
    const base = { head, post: [] as string[] };
    switch (method.name) {
      case 'filter': {
        const preds = props.filter((p) => p.role === 'predicate');
        for (const p of preds) {
          const adj = p.literal && /^[a-z][a-z0-9]*$/i.test(p.literal) ? { pre: [p.literal.toLowerCase()], post: [] } : asAdjective(p.name);
          if (!adj) continue;
          push({ ...base, pre: adj.pre, post: adj.post, plural: true, role: 'collection', evidence: [srcEv, mEv, { key: 'propertyMatch', note: `predicate on .${p.name}` }, tEv] });
          if (AVAILABILITY_PROPS.has(p.name.toLowerCase()) && !p.literal) {
            push({ ...base, pre: ['available'], plural: true, role: 'collection', evidence: [srcEv, mEv, { key: 'propertyMatch', note: `predicate on .${p.name}` }] });
          }
        }
        push({ ...base, pre: ['filtered'], plural: true, role: 'collection', evidence: [srcEv, mEv, tEv] });
        push({ ...base, pre: ['matching'], plural: true, role: 'collection', evidence: [srcEv, mEv, tEv] });
        break;
      }
      case 'map': {
        const proj = props.find((p) => p.role === 'projection');
        if (proj) {
          push({ ...base, post: splitWords(proj.name), pre: [], plural: true, role: 'collection', evidence: [srcEv, mEv, { key: 'propertyMatch', note: `projects .${proj.name}` }, tEv] });
        } else {
          push({ ...base, pre: ['mapped'], plural: true, role: 'collection', evidence: [srcEv, mEv, tEv] });
        }
        break;
      }
      case 'find':
      case 'findLast': {
        push({ ...base, pre: ['found'], plural: false, role: 'item', evidence: [srcEv, mEv, typeNote(' (single element)')] });
        push({ ...base, pre: ['matching'], plural: false, role: 'item', evidence: [srcEv, mEv, typeNote(' (single element)')] });
        push({ ...base, pre: [], plural: false, role: 'item', evidence: [srcEv, mEv] });
        break;
      }
      case 'findIndex':
      case 'indexOf':
        push({ ...base, post: ['index'], pre: [], plural: false, role: 'scalar', evidence: [srcEv, mEv, { key: 'typeMatch', note: 'index is a number' }] });
        break;
      case 'sort':
      case 'toSorted':
        push({ ...base, pre: ['sorted'], plural: true, role: 'collection', evidence: [srcEv, mEv, tEv] });
        break;
      case 'reverse':
      case 'toReversed':
        push({ ...base, pre: ['reversed'], plural: true, role: 'collection', evidence: [srcEv, mEv, tEv] });
        break;
      case 'concat':
        push({ ...base, pre: ['combined'], plural: true, role: 'collection', evidence: [srcEv, mEv, tEv] });
        push({ ...base, pre: ['all'], plural: true, role: 'collection', evidence: [srcEv, mEv, tEv] });
        break;
      case 'slice':
        push({ ...base, pre: ['selected'], plural: true, role: 'collection', evidence: [srcEv, mEv, tEv] });
        break;
      case 'length':
      case 'size':
        push({ ...base, post: ['count'], pre: [], plural: false, role: 'count', evidence: [srcEv, mEv, { key: 'typeMatch', note: 'length is a number' }] });
        break;
      case 'some':
      case 'includes':
        push({ ...base, pre: ['has'], plural: false, role: 'boolean', evidence: [srcEv, mEv, { key: 'typeMatch', note: 'boolean result' }] });
        break;
      case 'reduce': {
        const acc = props.find((p) => p.role === 'accumulate');
        if (acc) {
          push({ head: splitWords(acc.name), pre: ['total'], post: [], plural: false, role: 'scalar', evidence: [srcEv, mEv, { key: 'propertyMatch', note: `sums .${acc.name}` }, { key: 'typeMatch', note: 'numeric accumulation' }] });
        }
        break;
      }
      case 'keys':
      case 'values':
      case 'entries':
        push({ head: source.words, pre: [], post: [method.name], plural: false, role: 'collection', evidence: [srcEv, mEv, tEv] });
        break;
      case 'parse':
        push({ head: source.words, pre: ['parsed'], post: [], plural: source.plural, role: source.plural ? 'collection' : 'item', evidence: [srcEv, mEv] });
        break;
      default:
        break;
    }
  }

  // --- Calls with literals ---------------------------------------------------------------
  if (call?.callee === 'fetch' && call.argWords?.length) {
    push({ head: call.argWords, pre: [], post: ['response'], plural: false, role: 'scalar', evidence: [{ key: 'sourceMatch', note: `fetches "${call.arg}"` }, { key: 'methodMatch', note: 'fetch()' }, { key: 'typeMatch', note: 'a Response' }] });
  } else if (call?.callee === 'fetch') {
    push({ head: ['response'], pre: [], post: [], plural: false, role: 'scalar', evidence: [{ key: 'methodMatch', note: 'fetch()' }, { key: 'typeMatch', note: 'a Response' }] });
  }
  if (call?.callee === 'JSON.parse' && !out.length) {
    const w = call.argWords?.length ? call.argWords : undefined;
    if (w) push({ head: w, pre: ['parsed'], post: [], plural: false, role: 'scalar', evidence: [{ key: 'sourceMatch', note: `parses "${w.join(' ')}"` }, { key: 'methodMatch', note: 'JSON.parse()' }] });
  }

  // --- DOM lookups -----------------------------------------------------------------------
  if (dom) {
    const words = splitWords(dom.value.replace(/^[.#]/, ''));
    const clicks = usages.some((u) => u.kind === 'click');
    const domEv: Evidence[] = [
      { key: 'sourceMatch', note: `${dom.query} "${dom.value}"` },
      { key: 'methodMatch', note: dom.query === 'id' ? 'getElementById()' : 'DOM query' },
    ];
    if (words.length) {
      const last = words[words.length - 1];
      const multi = dom.query === 'selectorAll' || dom.query === 'classAll';
      if (!multi) {
        if (ELEMENT_SUFFIX.has(last)) {
          const w = [...words.slice(0, -1), ELEMENT_ALIASES[last] ?? last];
          push({ head: w, pre: [], post: [], plural: false, role: 'element', evidence: [...domEv, { key: 'typeMatch', note: 'DOM element' }, ...(clicks ? [{ key: 'usageMatch' as const, note: 'has click handler' }] : [])] });
        } else {
          push({ head: words, pre: [], post: ['element'], plural: false, role: 'element', evidence: [...domEv, { key: 'typeMatch', note: 'DOM element' }] });
          if (clicks) push({ head: words, pre: [], post: ['button'], plural: false, role: 'element', evidence: [...domEv, { key: 'usageMatch', note: 'has click handler' }, { key: 'typeMatch', note: 'DOM element' }] });
        }
      } else {
        push({ head: sing(words), pre: [], post: ['elements'].slice(0, 0), plural: true, role: 'elements', evidence: [...domEv, { key: 'typeMatch', note: 'DOM element list' }] });
        push({ head: sing(words), pre: [], post: ['element'], plural: true, role: 'elements', evidence: [...domEv, { key: 'typeMatch', note: 'DOM element list' }] });
      }
    }
  }

  // --- Callback parameters: element of a collection ---------------------------------------
  if (elementOf) {
    const head = sing(elementOf.words);
    const method = elementOf.method;
    if (method === 'reduce' && subject.name.length <= 4 && /^(acc|a|memo|accum|sum|total|t|r|res)$/i.test(subject.name) && subject.facts.some((f) => f.type === 'usage' && f.kind === 'accumulate')) {
      // handled by the accumulator rule below
    } else {
      push({ head, pre: [], post: [], plural: false, role: 'item', evidence: [{ key: 'sourceMatch', note: `element of "${elementOf.words.join(' ')}"` }, { key: 'methodMatch', note: `.${method}() callback` }, { key: 'typeMatch', note: 'single element' }, ...(usages.some((u) => u.kind === 'property') ? [{ key: 'usageMatch' as const, note: 'accessed as an object' }] : [])] });
    }
  }

  // --- Parameters named after what every caller passes ----------------------------------
  if (callsite) {
    const head = callsite.plural ? sing(callsite.words) : callsite.words;
    push({ head, pre: [], post: [], plural: callsite.plural, role: callsite.plural ? 'collection' : 'item', evidence: [{ key: 'sourceMatch', note: `callers pass "${callsite.words.join(' ')}" (${callsite.count} call site${callsite.count > 1 ? 's' : ''})` }, { key: 'usageMatch', note: 'consistent at every call site' }] });
  }

  // --- Usage driven names ------------------------------------------------------------------
  for (const u of usages) {
    if (u.kind === 'push' && u.words?.length && vtype === 'array') {
      push({ head: sing(u.words), pre: [], post: [], plural: true, role: 'collection', evidence: [{ key: 'sourceMatch', note: `collects "${u.words.join(' ')}"` }, { key: 'usageMatch', note: '.push(...)' }, typeNote()] });
    }
    if (u.kind === 'accumulate' && u.property && vtype === 'number') {
      push({ head: splitWords(u.property), pre: ['total'], post: [], plural: false, role: 'scalar', evidence: [{ key: 'propertyMatch', note: `sums .${u.property}` }, { key: 'usageMatch', note: 'accumulated in a loop' }, { key: 'typeMatch', note: 'numeric' }] });
    }
    if (u.kind === 'increment' && vtype === 'number' && !subject.facts.some((f) => f.type === 'source')) {
      push({ head: u.words?.length ? u.words : ['item'], pre: [], post: ['count'], plural: false, role: 'count', evidence: [{ key: 'usageMatch', note: 'incremented' }, { key: 'typeMatch', note: 'numeric' }, ...(u.words?.length ? [{ key: 'sourceMatch' as const, note: `counts "${u.words.join(' ')}"` }] : [])] });
    }
  }

  // --- Context (file / enclosing function) -------------------------------------------------
  const ctx = find(facts, 'context');
  if (ctx && ctx.words.length && out.length === 0 && ['array', 'object'].includes(vtype)) {
    push({ head: sing(ctx.words), pre: [], post: [], plural: vtype === 'array', role: vtype === 'array' ? 'collection' : 'item', evidence: [{ key: 'contextMatch', note: `file/function "${ctx.words.join(' ')}"` }, typeNote()] });
  }

  return out;
}

// ----------------------------------------------------------------------------------------------

export function renderSpec(spec: NameSpec, convention: NamingConvention, style: 'convention' | 'plural'): { name: string; followsConvention: boolean } {
  const casing: 'camel' | 'snake' = convention.casing;
  let words = [...spec.pre, ...spec.head, ...spec.post].filter(Boolean);
  let followsConvention = false;
  if (spec.plural && words.length) {
    const useSuffix = style === 'convention' && convention.collection.startsWith('suffix-');
    if (useSuffix) {
      words = [...words, convention.collection.slice('suffix-'.length).toLowerCase()];
      followsConvention = true;
    } else {
      const last = words[words.length - 1];
      words = [...words.slice(0, -1), looksPlural(last) ? last : pluralize(last)];
      followsConvention = style === 'convention' && convention.collection === 'plural';
    }
  }
  if (spec.role === 'boolean' && convention.booleanPrefix !== 'none' && words[0] !== 'has' && words[0] !== 'is') {
    words = [convention.booleanPrefix, ...words];
    followsConvention = true;
  }
  if (convention.casing === 'snake' && convention.casingStrength >= 0.6) followsConvention = followsConvention || false;
  return { name: joinWords(words, casing), followsConvention };
}

export function valueTypeFromRole(role: Role): ValueType | undefined {
  switch (role) {
    case 'collection': return 'array';
    case 'count': return 'number';
    case 'boolean': return 'boolean';
    case 'element': return 'element';
    case 'elements': return 'elements';
    default: return undefined;
  }
}
