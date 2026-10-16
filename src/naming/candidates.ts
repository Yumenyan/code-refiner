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
const expandAliases = (words: string[]) => words.map((w) => ELEMENT_ALIASES[w] ?? w);
const RESULT_VERBS = new Set(['get', 'load', 'fetch', 'build', 'create', 'make', 'compute', 'calculate', 'calc', 'find', 'read', 'parse', 'collect', 'extract', 'generate']);
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

  // --- Result of a project function: const total = calcTotal()  ->  total ---------------------
  if (call && call.callee !== 'fetch' && call.callee !== 'JSON.parse' && !call.callee.includes('.')) {
    const ws = splitWords(call.callee);
    if (ws.length >= 2 && RESULT_VERBS.has(ws[0])) {
      const rest = ws.slice(1);
      const last = rest[rest.length - 1];
      const plural = looksPlural(last);
      push({ head: plural ? sing(rest) : rest, pre: [], post: [], plural, role: plural ? 'collection' : 'item', evidence: [{ key: 'sourceMatch', note: `result of ${call.callee}()` }, { key: 'methodMatch', note: `"${ws[0]}" returns what follows it` }] });
    }
  }

  // --- DOM lookups ---------------------------------------------------------------------
  const domRead = props.find((p) => p.role === 'read');
  if (dom && domRead) {
    const words = expandAliases(splitWords(dom.value.replace(/^[.#]/, '')));
    push({ head: words, pre: [], post: [domRead.name === 'checked' ? 'checked' : domRead.name === 'innerHTML' ? 'html' : domRead.name === 'textContent' || domRead.name === 'innerText' ? 'text' : domRead.name], plural: false, role: domRead.name === 'checked' ? 'boolean' : 'scalar', evidence: [{ key: 'sourceMatch', note: `${dom.query} "${dom.value}"` }, { key: 'methodMatch', note: 'DOM query' }, { key: 'propertyMatch', note: `reads .${domRead.name}` }, { key: 'typeMatch', note: vtype === 'boolean' ? 'boolean' : 'string' }] });
  }

  if (dom && !props.some((p) => p.role === 'read')) {
    const words = splitWords(dom.value.replace(/^[.#]/, ''));
    const clicks = usages.some((u) => u.kind === 'click');
    const used = usages.some((u) => u.kind === 'property' || u.kind === 'sink');
    const usedEv: Evidence[] = used ? [{ key: 'usageMatch', note: 'its properties are read / written' }] : [];
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
          push({ head: w, pre: [], post: [], plural: false, role: 'element', evidence: [...domEv, { key: 'typeMatch', note: 'DOM element' }, ...(clicks ? [{ key: 'usageMatch' as const, note: 'has click handler' }] : usedEv)] });
        } else {
          push({ head: words, pre: [], post: ['element'], plural: false, role: 'element', evidence: [...domEv, { key: 'typeMatch', note: 'DOM element' }, ...usedEv] });
          if (clicks) push({ head: words, pre: [], post: ['button'], plural: false, role: 'element', evidence: [...domEv, { key: 'usageMatch', note: 'has click handler' }, { key: 'typeMatch', note: 'DOM element' }] });
        }
      } else {
        push({ head: sing(words), pre: [], post: ['elements'].slice(0, 0), plural: true, role: 'elements', evidence: [...domEv, { key: 'typeMatch', note: 'DOM element list' }] });
        push({ head: sing(words), pre: [], post: ['element'], plural: true, role: 'elements', evidence: [...domEv, { key: 'typeMatch', note: 'DOM element list' }] });
      }
    }
  }

  // --- Function names: from wiring (event handlers), rendering and what is returned ---------------
  if (subject.kind === 'function') {
    const handler = find(facts, 'handler');
    if (handler?.targetWords.length) {
      const target = expandAliases(handler.targetWords);
      // `handleAddButtonClick`; a target that already ends in the event ("click-area") is not repeated
      const post = target[target.length - 1] === handler.event ? [] : [handler.event];
      push({ head: target, pre: ['handle'], post, plural: false, role: 'function', evidence: [{ key: 'sourceMatch', note: `registered for "${handler.event}" on "${handler.targetWords.join(' ')}"` }, { key: 'usageMatch', note: 'used as an event handler' }, { key: 'methodMatch', note: 'addEventListener / on* wiring' }, { key: 'typeMatch', note: 'a function' }] });
    } else if (handler) {
      push({ head: [handler.event], pre: ['handle'], post: [], plural: false, role: 'function', evidence: [{ key: 'usageMatch', note: `registered for "${handler.event}"` }, { key: 'methodMatch', note: 'addEventListener / on* wiring' }] });
    }
    const renders = find(facts, 'renders');
    if (renders?.words.length) {
      push({ head: renders.words, pre: ['render'], post: [], plural: false, role: 'function', evidence: [{ key: 'sourceMatch', note: `writes into "${renders.words.join(' ')}"` }, { key: 'usageMatch', note: 'sets innerHTML / textContent' }, { key: 'methodMatch', note: 'DOM output' }, { key: 'typeMatch', note: 'a function' }] });
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

  // --- Sinks: a string that ends up in innerHTML is HTML --------------------------------------
  for (const u of usages) {
    if (u.kind === 'sink' && u.property && vtype === 'string') {
      const name = u.property === 'innerHTML' || u.property === 'outerHTML' ? 'html' : u.property === 'textContent' || u.property === 'innerText' ? 'text' : '';
      if (name) push({ head: [name], pre: [], post: [], plural: false, role: 'scalar', evidence: [{ key: 'sourceMatch', note: `flows into .${u.property}` }, { key: 'methodMatch', note: `.${u.property} = ...` }, { key: 'usageMatch', note: 'built up, then rendered' }, { key: 'typeMatch', note: 'string' }] });
    }
    if (u.kind === 'push' && u.predicate && u.words?.length && vtype === 'array') {
      const adj = asAdjective(u.predicate);
      if (adj) push({ head: sing(u.words), pre: adj.pre, post: adj.post, plural: true, role: 'collection', evidence: [{ key: 'sourceMatch', note: `collects "${u.words.join(' ')}"` }, { key: 'usageMatch', note: '.push(...) inside a condition' }, { key: 'propertyMatch', note: `filters on .${u.predicate}` }, typeNote()] });
    }
  }
  const built = find(facts, 'builtBy');
  if (built && usages.some((u) => u.kind === 'returned')) {
    push({ head: sing(built.words), pre: [], post: [], plural: false, role: 'item', evidence: [{ key: 'sourceMatch', note: `created by ${built.verb}${built.words.join(' ')}` }, { key: 'methodMatch', note: `"${built.verb}" creates what follows it` }, { key: 'usageMatch', note: 'returned from the function' }, { key: 'typeMatch', note: 'an object' }] });
  }

  // --- Context (file / enclosing function) -------------------------------------------------
  const ctx = find(facts, 'context');
  if (ctx && ctx.words.length && out.length === 0 && ['array', 'object'].includes(vtype)) {
    push({ head: sing(ctx.words), pre: [], post: [], plural: vtype === 'array', role: vtype === 'array' ? 'collection' : 'item', evidence: [{ key: 'contextMatch', note: `file/function "${ctx.words.join(' ')}"` }, typeNote()] });
  }

  if (subject.kind === 'function') {
    // A function that returns a value is named for what it returns: activeStations -> getActiveStations
    return out.map((spec) => {
      if (spec.role === 'function' || spec.role === 'boolean') return spec;
      if (spec.role === 'count') return { ...spec, pre: ['count', ...spec.pre], post: spec.post.filter((w) => w !== 'count') };
      return { ...spec, pre: ['get', ...spec.pre] };
    });
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
    } else if (/[^\u0000-\u007f]/.test(words[words.length - 1])) {
      // No English plural for e.g. Japanese words: mark the collection with a suffix instead
      words = [...words, convention.collection.startsWith('suffix-') ? convention.collection.slice('suffix-'.length).toLowerCase() : 'list'];
      followsConvention = style === 'convention' && convention.collection.startsWith('suffix-');
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
