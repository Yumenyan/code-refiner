/**
 * Language neutral facts about a name-bearing entity. Language packs extract
 * facts from their syntax tree; the naming engine turns facts into candidates.
 */
export type ValueType =
  | 'array' | 'string' | 'number' | 'boolean' | 'object' | 'function' | 'element' | 'elements'
  | 'map' | 'set' | 'promise' | 'regexp' | 'unknown';

export type Fact =
  /** The value derives from something named `words` (singular lemma). */
  | { type: 'source'; words: string[]; plural: boolean }
  /** A method/function that produced the value (filter, map, find, ...). */
  | { type: 'method'; name: string }
  /** A property read inside a predicate/projection/accumulator. */
  | { type: 'property'; name: string; role: 'predicate' | 'projection' | 'accumulate'; literal?: string }
  | { type: 'valueType'; value: ValueType }
  /** DOM lookup with a literal query. */
  | { type: 'dom'; query: 'id' | 'class' | 'selector' | 'selectorAll' | 'classAll' | 'tag'; value: string }
  | {
      type: 'usage';
      kind: 'push' | 'increment' | 'accumulate' | 'click' | 'iterate' | 'property' | 'boolean-test';
      words?: string[];
      plural?: boolean;
      property?: string;
    }
  /** Names of the arguments passed at every known call site (parameters only). */
  | { type: 'callsite'; words: string[]; plural: boolean; count: number }
  /** The entity is an element of a collection named `words` (callback parameter). */
  | { type: 'element-of'; words: string[]; method: string }
  | { type: 'call'; callee: string; arg?: string; argWords?: string[] }
  | { type: 'context'; words: string[] };

export interface NamingSubject {
  file: string;
  name: string;
  kind: 'variable' | 'parameter';
  valueType: ValueType;
  facts: Fact[];
  /** Every identifier that would collide if used in the same scope chain. */
  takenNames: Set<string>;
}
