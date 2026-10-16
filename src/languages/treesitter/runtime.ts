/**
 * Tree-sitter runtime (WebAssembly). One loader abstraction serves Node (reads wasm from
 * node_modules) and the browser (fetches wasm files next to the page).
 */
import Parser from 'web-tree-sitter';

export type WasmLoader = (name: string) => Promise<Uint8Array | string>;

let loader: WasmLoader | null = null;
let initPromise: Promise<void> | null = null;
const languages = new Map<string, Promise<Parser.Language>>();

export function configureTreeSitter(l: WasmLoader, opts?: { initOptions?: object }): void {
  loader = l;
  initPromise = null;
  languages.clear();
  (configureTreeSitter as { initOptions?: object }).initOptions = opts?.initOptions;
}

async function nodeLoader(name: string): Promise<Uint8Array | string> {
  const { createRequire } = await import('node:module');
  const { readFile } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');
  const req = createRequire(import.meta.url);
  const pkg = dirname(req.resolve('tree-sitter-wasms/package.json'));
  return readFile(join(pkg, 'out', name));
}

function ensureInit(): Promise<void> {
  initPromise ??= Parser.init((configureTreeSitter as { initOptions?: object }).initOptions as never);
  return initPromise;
}

export async function loadLanguage(wasmName: string): Promise<Parser.Language> {
  await ensureInit();
  let p = languages.get(wasmName);
  if (!p) {
    p = (async () => {
      const src = await (loader ?? nodeLoader)(wasmName);
      return Parser.Language.load(src as never);
    })();
    languages.set(wasmName, p);
  }
  return p;
}

export function newParser(lang: Parser.Language): Parser {
  const p = new Parser();
  p.setLanguage(lang);
  return p;
}

export type { Parser };
export type SyntaxNode = Parser.SyntaxNode;
