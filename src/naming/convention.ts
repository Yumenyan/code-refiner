import { Casing, detectCasing, looksPlural, splitWords } from './words.js';

export type CollectionStyle = 'plural' | 'suffix-List' | 'suffix-Array' | 'suffix-Items' | 'unknown';

export interface NamingConvention {
  /** Dominant casing for local variables / parameters. */
  casing: 'camel' | 'snake';
  casingStrength: number;
  collection: CollectionStyle;
  collectionStrength: number;
  booleanPrefix: 'is' | 'has' | 'none';
  /** Observation counts, for the report. */
  samples: { collections: number; booleans: number; names: number };
}

export interface ConventionSample {
  name: string;
  /** What the name holds, as far as the analyser could tell. */
  valueType?: string;
}

export function detectConvention(samples: ConventionSample[]): NamingConvention {
  let camel = 0;
  let snake = 0;
  const coll: Record<CollectionStyle, number> = { plural: 0, 'suffix-List': 0, 'suffix-Array': 0, 'suffix-Items': 0, unknown: 0 };
  let collections = 0;
  let booleans = 0;
  let isPrefix = 0;
  let hasPrefix = 0;

  for (const s of samples) {
    const casing: Casing = detectCasing(s.name);
    if (casing === 'camel') camel++;
    else if (casing === 'snake') snake++;

    const words = splitWords(s.name);
    const last = words[words.length - 1];
    if (s.valueType === 'array' && words.length) {
      collections++;
      if (words.length >= 2 && last === 'list') coll['suffix-List']++;
      else if (words.length >= 2 && last === 'array') coll['suffix-Array']++;
      else if (words.length >= 2 && last === 'items') coll['suffix-Items']++;
      else if (looksPlural(last)) coll.plural++;
    }
    if (s.valueType === 'boolean') {
      booleans++;
      if (words[0] === 'is') isPrefix++;
      else if (words[0] === 'has') hasPrefix++;
    }
  }

  let collection: CollectionStyle = 'unknown';
  let best = 0;
  for (const k of ['plural', 'suffix-List', 'suffix-Array', 'suffix-Items'] as const) {
    if (coll[k] > best) {
      best = coll[k];
      collection = k;
    }
  }
  const classified = Object.values(coll).reduce((a, b) => a + b, 0);
  const collectionStrength = classified >= 3 ? best / classified : 0;
  const casingTotal = camel + snake;
  const casing = snake > camel ? 'snake' : 'camel';
  return {
    casing,
    casingStrength: casingTotal ? Math.max(camel, snake) / casingTotal : 0,
    collection: collectionStrength >= 0.55 ? collection : 'unknown',
    collectionStrength,
    booleanPrefix: booleans >= 3 && isPrefix + hasPrefix > 0 ? (isPrefix >= hasPrefix ? 'is' : 'has') : 'none',
    samples: { collections: classified, booleans, names: samples.length },
  };
}

export function defaultConvention(): NamingConvention {
  return {
    casing: 'camel',
    casingStrength: 0,
    collection: 'unknown',
    collectionStrength: 0,
    booleanPrefix: 'none',
    samples: { collections: 0, booleans: 0, names: 0 },
  };
}

export function describeConvention(c: NamingConvention): string[] {
  const out = [`casing: ${c.casing}case (${Math.round(c.casingStrength * 100)}%)`];
  out.push(
    c.collection === 'unknown'
      ? 'collections: no clear rule'
      : `collections: ${c.collection === 'plural' ? 'plural noun' : 'xxx' + c.collection.slice('suffix-'.length)} (${Math.round(c.collectionStrength * 100)}%)`,
  );
  out.push(`booleans: ${c.booleanPrefix === 'none' ? 'no clear prefix' : c.booleanPrefix + '…'}`);
  return out;
}
