import { basename } from '../../core/text.js';
import { prettierFormatter } from '../prettier.js';
import { getPrettier } from '../prettier-api.js';
import type { LanguagePack } from '../types.js';
import type { Options as PrettierOptions } from 'prettier';

interface Spec {
  id: string;
  displayName: string;
  extensions: string[];
  parser: string;
}

export const PRETTIER_LANGUAGES: Spec[] = [
  { id: 'scss', displayName: 'SCSS', extensions: ['.scss'], parser: 'scss' },
  { id: 'less', displayName: 'Less', extensions: ['.less'], parser: 'less' },
  { id: 'markdown', displayName: 'Markdown', extensions: ['.md', '.markdown'], parser: 'markdown' },
  { id: 'yaml', displayName: 'YAML', extensions: ['.yml', '.yaml'], parser: 'yaml' },
  { id: 'vue', displayName: 'Vue', extensions: ['.vue'], parser: 'vue' },
  { id: 'graphql', displayName: 'GraphQL', extensions: ['.graphql', '.gql'], parser: 'graphql' },
];

/**
 * Formatting-only packs backed by Prettier. Because there is no AST-equivalence proof for these
 * formats, output is accepted only if it parses again and re-formatting it is a no-op (idempotent).
 */
export function prettierLanguagePack(spec: Spec, overrides: PrettierOptions = {}): LanguagePack {
  const formatter = prettierFormatter({ parser: spec.parser, inferQuotes: spec.id === 'scss' || spec.id === 'less' }, overrides);
  const check = async (source: string) => {
    try {
      await (await getPrettier()).format(source, { parser: spec.parser });
      return { ok: true } as const;
    } catch (e) {
      return { ok: false, error: (e as Error).message.split('\n')[0] } as const;
    }
  };
  return {
    id: spec.id,
    displayName: spec.displayName,
    extensions: spec.extensions,
    formatter,
    rules: [],
    checkSyntax: check,
    async refine({ file, source }) {
      const out = { code: source, changes: [], suggestions: [], warnings: [] } as Awaited<ReturnType<LanguagePack['refine']>>;
      try {
        const formatted = await formatter.format(source, file);
        if (formatted === source) return out;
        const again = await formatter.format(formatted, file);
        if (again !== formatted) {
          out.warnings.push({ code: 'format-skipped', file, message: `${basename(file)}: formatter output was not stable; left unformatted` });
          return out;
        }
        out.code = formatted;
        out.changes.push({ file, kind: 'format', ruleId: 'format', level: 'safe', description: `Formatted (${formatter.id})`, confidence: 1 });
      } catch (e) {
        out.warnings.push({ code: 'syntax-error', file, message: `Skipped: ${(e as Error).message.split('\n')[0]}` });
      }
      return out;
    },
  };
}
