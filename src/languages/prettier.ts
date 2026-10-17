import type { Options as PrettierOptions } from 'prettier';
import { getPrettier } from './prettier-api.js';
import type { FormatterAdapter } from './types.js';

export interface PrettierFormatterOptions {
  parser: string;
  /** Detect quote style from the source so formatting does not flip the project's style. */
  inferQuotes?: boolean;
}

function inferSingleQuote(source: string): boolean {
  const single = (source.match(/'[^'\n]*'/g) ?? []).length;
  const double = (source.match(/"[^"\n]*"/g) ?? []).length;
  return single > double;
}

/** Infers tabs / indentation width from the lines of a file so reformatting keeps the project's look. */
export function inferIndent(source: string): { useTabs: boolean; tabWidth: number } | null {
  let tabs = 0;
  const widths = new Map<number, number>();
  let prev = 0;
  for (const line of source.split('\n')) {
    if (!line.trim()) continue;
    if (line.startsWith('\t')) {
      tabs++;
      continue;
    }
    const lead = line.length - line.trimStart().length;
    if (lead > prev && lead - prev <= 8) widths.set(lead - prev, (widths.get(lead - prev) ?? 0) + 1);
    prev = lead;
  }
  const spaceTotal = [...widths.values()].reduce((a, b) => a + b, 0);
  if (tabs > spaceTotal && tabs >= 3) return { useTabs: true, tabWidth: 4 };
  if (spaceTotal < 3) return null;
  const best = [...widths.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return best === 2 || best === 4 ? { useTabs: false, tabWidth: best } : null;
}

function inferPrintWidth(source: string): number {
  const lens = source.split('\n').map((l) => l.length).filter((n) => n > 0).sort((a, b) => a - b);
  if (lens.length < 20) return 100;
  const p95 = lens[Math.floor(lens.length * 0.95)];
  return p95 > 110 ? 120 : p95 <= 82 ? 80 : 100;
}

/**
 * Formatter Adapter for Prettier. Project formatting preferences are passed in
 * explicitly (parsed from the project's own `.prettierrc`), never discovered on
 * the machine running CodeRefiner.
 */
export function prettierFormatter(opts: PrettierFormatterOptions, overrides: PrettierOptions = {}): FormatterAdapter {
  return {
    id: `prettier:${opts.parser}`,
    async format(source, _file, fmt) {
      // Old engines (Rhino, ES5 browsers) choke on trailing commas and some modern punctuation.
      const legacy: PrettierOptions = fmt?.ecma && fmt.ecma < 2017 ? { trailingComma: 'none', quoteProps: fmt.ecma < 5 ? 'preserve' : 'as-needed' } : {};
      const base: PrettierOptions = {
        printWidth: opts.inferQuotes ? inferPrintWidth(source) : 100,
        tabWidth: 2,
        endOfLine: 'auto',
        ...(opts.inferQuotes ? { singleQuote: inferSingleQuote(source) } : {}),
        ...(opts.inferQuotes ? inferIndent(source) ?? {} : {}),
      };
      return (await getPrettier()).format(source, { ...base, ...overrides, ...legacy, parser: opts.parser });
    },
  };
}
