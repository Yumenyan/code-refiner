import type { Options as PrettierOptions } from 'prettier';
import { cssPack } from './css/pack.js';
import { htmlPack } from './html/pack.js';
import { ecmaPack } from './javascript/pack.js';
import { jsonPack } from './json/pack.js';
import { prettierFormatter } from './prettier.js';
import { LanguageRegistry } from './registry.js';
import { externalFormatterPacks } from './external/pack.js';

export { LanguageRegistry } from './registry.js';
export type { LanguagePack } from './types.js';

/** Registry with all built-in Language Packs. */
export function createDefaultRegistry(opts: { prettier?: PrettierOptions } = {}): LanguageRegistry {
  const reg = new LanguageRegistry();
  const o = opts.prettier ?? {};
  reg.register(ecmaPack({ id: 'javascript', displayName: 'JavaScript', extensions: ['.js', '.mjs', '.cjs', '.jsx'], formatter: prettierFormatter({ parser: 'babel', inferQuotes: true }, o) }));
  reg.register(ecmaPack({ id: 'typescript', displayName: 'TypeScript', extensions: ['.ts', '.mts', '.cts', '.tsx'], formatter: prettierFormatter({ parser: 'typescript', inferQuotes: true }, o) }));
  reg.register(htmlPack(prettierFormatter({ parser: 'html' }, o)));
  reg.register(cssPack(prettierFormatter({ parser: 'css' }, o)));
  reg.register(jsonPack());
  for (const p of externalFormatterPacks()) reg.register(p);
  return reg;
}
