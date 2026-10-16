import { isDeepStrictEqual } from 'node:util';
import { basename } from '../../core/text.js';
import type { FormatterAdapter, LanguagePack } from '../types.js';
import * as prettier from 'prettier';

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

const STRINGIFY_FILES = new Set(['package.json', 'package-lock.json', 'composer.json', 'bower.json']);

export function jsonFormatter(): FormatterAdapter {
  return {
    id: 'prettier:json',
    async format(source, file) {
      const parser = STRINGIFY_FILES.has(basename(file)) ? 'json-stringify' : 'json';
      return prettier.format(source, { parser, tabWidth: 2, endOfLine: 'auto' });
    },
  };
}

export function jsonPack(formatter: FormatterAdapter = jsonFormatter()): LanguagePack {
  const check = (source: string) => {
    if (tryParse(source).ok) return { ok: true };
    // JSON with comments (tsconfig.json, .eslintrc ...): accept when Prettier's tolerant parser can read it.
    return prettier.format(source, { parser: 'json' }).then(
      () => ({ ok: true }),
      (e: Error) => ({ ok: false, error: e.message }),
    );
  };
  return {
    id: 'json',
    displayName: 'JSON',
    extensions: ['.json', '.jsonc'],
    formatter,
    rules: [],
    checkSyntax: (source) => check(source),
    async refine(input) {
      const out = { code: input.source, changes: [], suggestions: [], warnings: [] } as Awaited<ReturnType<LanguagePack['refine']>>;
      const before = tryParse(input.source);
      try {
        const formatted = await formatter.format(input.source, input.file);
        const after = tryParse(formatted);
        if (before.ok && (!after.ok || !isDeepStrictEqual(before.value, after.value))) {
          out.warnings.push({ code: 'format-skipped', file: input.file, message: 'Formatted JSON differed from the original data; left untouched' });
          return out;
        }
        out.code = formatted;
        if (formatted !== input.source) out.changes.push({ file: input.file, kind: 'format', ruleId: 'format', level: 'safe', description: `Formatted (${formatter.id})`, confidence: 1 });
      } catch (e) {
        out.warnings.push({ code: 'syntax-error', file: input.file, message: `Skipped: ${(e as Error).message.split('\n')[0]}` });
      }
      return out;
    },
    isEquivalent(a, b) {
      const pa = tryParse(a);
      const pb = tryParse(b);
      return pa.ok && pb.ok ? isDeepStrictEqual(pa.value, pb.value) : undefined;
    },
  };
}
