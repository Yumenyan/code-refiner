import type { Options as PrettierOptions } from 'prettier';
import { cssPack } from './css/pack.js';
import { htmlPack } from './html/pack.js';
import { ecmaPack } from './javascript/pack.js';
import { jsonPack } from './json/pack.js';
import { PRETTIER_LANGUAGES, prettierLanguagePack } from './prettier-langs/pack.js';
import { prettierFormatter } from './prettier.js';
import { LanguageRegistry } from './registry.js';
import { nativePacks, parserOnlyPacks } from './treesitter/languages.js';

export { LanguageRegistry } from './registry.js';
export type { LanguagePack } from './types.js';

export interface RegistryOptions {
  prettier?: PrettierOptions;
  /** Use formatters installed on this machine (gofmt, rustfmt, ruff, clang-format ...). Default: true under Node. */
  native?: boolean;
}

/** HTML / CSS / JS / TS / JSON plus the Prettier-backed formats (SCSS, Less, Markdown, YAML, Vue, GraphQL). Synchronous. */
export function createCoreRegistry(opts: RegistryOptions = {}): LanguageRegistry {
  const reg = new LanguageRegistry();
  const o = opts.prettier ?? {};
  reg.register(ecmaPack({ id: 'javascript', displayName: 'JavaScript', extensions: ['.js', '.mjs', '.cjs', '.jsx'], formatter: prettierFormatter({ parser: 'babel', inferQuotes: true }, o) }));
  reg.register(ecmaPack({ id: 'typescript', displayName: 'TypeScript', extensions: ['.ts', '.mts', '.cts', '.tsx'], formatter: prettierFormatter({ parser: 'typescript', inferQuotes: true }, o) }));
  reg.register(htmlPack(prettierFormatter({ parser: 'html' }, o)));
  reg.register(cssPack(prettierFormatter({ parser: 'css' }, o)));
  reg.register(jsonPack());
  for (const spec of PRETTIER_LANGUAGES) reg.register(prettierLanguagePack(spec, o));
  return reg;
}

const isNode = () => typeof process !== 'undefined' && !!(process as { versions?: { node?: string } }).versions?.node;

/** Every built-in Language Pack, including the parser-backed ones (Java, C#, Go, Python, Rust, Ruby, PHP, Kotlin, Swift, C, C++, Shell, Scala). */
export async function createRegistry(opts: RegistryOptions = {}): Promise<LanguageRegistry> {
  const reg = createCoreRegistry(opts);
  const packs = (opts.native ?? isNode()) ? await nativePacks() : parserOnlyPacks();
  for (const p of packs) reg.register(p);
  return reg;
}

/** @deprecated kept for callers that only need the synchronous core packs */
export const createDefaultRegistry = createCoreRegistry;
