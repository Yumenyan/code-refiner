import { STOPWORDS, singularize, splitWords } from './words.js';

export interface VocabularyEntry {
  word: string;
  count: number;
  /** Distinct spellings of identifiers containing the stem (e.g. stationList, stationData). */
  variants: string[];
}

export interface AbbreviationHint {
  abbreviation: string;
  expansion: string;
  count: number;
}

export interface Vocabulary {
  entries: VocabularyEntry[];
  /** Variant groups: stem -> spellings. Only stems with at least 2 distinct spellings. */
  variantGroups: Record<string, string[]>;
  abbreviations: AbbreviationHint[];
  has(word: string): boolean;
  count(word: string): number;
}

export class VocabularyBuilder {
  private counts = new Map<string, number>();
  private spellings = new Map<string, Set<string>>();
  private raw = new Map<string, number>();

  /** Feed every identifier (declaration names, property names, ids, class names). */
  add(identifier: string, weight = 1): void {
    if (!identifier || identifier.length > 60) return;
    this.raw.set(identifier, (this.raw.get(identifier) ?? 0) + weight);
    for (const w of splitWords(identifier)) {
      if (w.length < 3 || /^\d+$/.test(w)) continue;
      const stem = singularize(w);
      if (STOPWORDS.has(stem) || STOPWORDS.has(w)) continue;
      this.counts.set(stem, (this.counts.get(stem) ?? 0) + weight);
      let set = this.spellings.get(stem);
      if (!set) this.spellings.set(stem, (set = new Set()));
      set.add(identifier);
    }
  }

  build(minCount = 2): Vocabulary {
    const entries: VocabularyEntry[] = [...this.counts.entries()]
      .filter(([, c]) => c >= minCount)
      .map(([word, count]) => ({ word, count, variants: [...(this.spellings.get(word) ?? [])].sort() }))
      .sort((a, b) => b.count - a.count || (a.word < b.word ? -1 : 1));

    const variantGroups: Record<string, string[]> = {};
    for (const e of entries) {
      // Spellings that *are* the stem word itself in different inflections / affixes.
      const forms = e.variants.filter((v) => {
        const ws = splitWords(v);
        return ws.length <= 3;
      });
      if (new Set(forms).size >= 2) variantGroups[e.word] = forms.slice(0, 12);
    }

    // Abbreviations: short, non-vocabulary tokens that are subsequences of a vocabulary word.
    const vocabWords = entries.filter((e) => e.count >= 3 && e.word.length >= 5);
    const abbr = new Map<string, AbbreviationHint>();
    for (const [identifier, c] of this.raw) {
      for (const tok of splitWords(identifier)) {
        if (tok.length < 2 || tok.length > 5) continue;
        const own = this.counts.get(singularize(tok)) ?? 0;
        const match = vocabWords.find((v) => v.word !== singularize(tok) && isAbbreviationOf(tok, v.word));
        // A short token only counts as an abbreviation when the spelled-out word is established too.
        if (match && match.count >= Math.max(3, own / 2)) {
          const prev = abbr.get(tok);
          abbr.set(tok, { abbreviation: tok, expansion: match.word, count: (prev?.count ?? 0) + c });
        }
      }
    }
    const index = new Map(entries.map((e) => [e.word, e.count]));
    return {
      entries,
      variantGroups,
      abbreviations: [...abbr.values()].sort((a, b) => b.count - a.count),
      has: (w) => index.has(singularize(w.toLowerCase())),
      count: (w) => index.get(singularize(w.toLowerCase())) ?? 0,
    };
  }
}

/** `stn` -> `station`: same first letter, all letters in order, and at least 2 letters. */
export function isAbbreviationOf(abbr: string, word: string): boolean {
  if (abbr.length < 2 || abbr.length >= word.length || abbr[0] !== word[0]) return false;
  let j = 0;
  for (let i = 0; i < word.length && j < abbr.length; i++) if (word[i] === abbr[j]) j++;
  // Require that the last letter also anchors, which filters out very loose matches ("sn" -> "station" is fine).
  return j === abbr.length && (abbr.length >= 3 || word.length <= 8);
}

export function emptyVocabulary(): Vocabulary {
  return { entries: [], variantGroups: {}, abbreviations: [], has: () => false, count: () => 0 };
}
