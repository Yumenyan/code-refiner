import type { LanguagePack, FormatterAdapter } from '../types.js';
import { ECMA_RULES } from './rules.js';
import { parseEcma, errorMessage, type EcmaLanguage } from './parser.js';
import { refineEcma, surfaceOf } from './refine.js';
import { analyzeEcma } from './semantic.js';
import { sameAst } from './ast-compare.js';

export function ecmaPack(opts: {
  id: EcmaLanguage;
  displayName: string;
  extensions: string[];
  formatter: FormatterAdapter;
}): LanguagePack {
  const language = opts.id;
  return {
    id: opts.id,
    displayName: opts.displayName,
    extensions: opts.extensions,
    formatter: opts.formatter,
    rules: ECMA_RULES.map((r) => ({ id: r.id, description: r.description, level: r.level })),
    checkSyntax(source, file) {
      try {
        parseEcma(source, file, language);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: errorMessage(e) };
      }
    },
    analyze({ file, source }) {
      const sem = analyzeEcma(source, file, language);
      return 'error' in sem ? {} : { semantic: sem };
    },
    refine: (input) => refineEcma(input, language, opts.formatter),
    isEquivalent(before, after, file) {
      try {
        return sameAst(parseEcma(before, file, language), parseEcma(after, file, language));
      } catch {
        return undefined;
      }
    },
    surface: (source, file) => surfaceOf(source, file, language),
  };
}
