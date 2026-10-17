import { available, blackFormatter, clangFormatter, gofmtFormatter, googleJavaFormatter, pythonFormatter, ruffFormatter, rustfmtFormatter, shfmtFormatter } from '../external/tools.js';
import type { LanguagePack } from '../types.js';
import { treeSitterPack, type TreeSitterSpec } from './pack.js';

type Spec = Omit<TreeSitterSpec, 'formatter' | 'equivalence'>;

/** Parser-backed languages: syntax check, project vocabulary, function metrics, duplicates, plus native formatting when installed. */
export const TREE_SITTER_SPECS: Spec[] = [
  { id: 'java', displayName: 'Java', extensions: ['.java'], wasm: 'tree-sitter-java.wasm', functionTypes: ['method_declaration', 'constructor_declaration', 'lambda_expression'] , reflow: {  } },
  { id: 'csharp', displayName: 'C#', extensions: ['.cs'], wasm: 'tree-sitter-c_sharp.wasm', functionTypes: ['method_declaration', 'constructor_declaration', 'local_function_statement', 'lambda_expression'] , reflow: {  } },
  { id: 'go', displayName: 'Go', extensions: ['.go'], wasm: 'tree-sitter-go.wasm', functionTypes: ['function_declaration', 'method_declaration', 'func_literal'] , reflow: { indent: '\t' } },
  { id: 'python', displayName: 'Python', extensions: ['.py'], wasm: 'tree-sitter-python.wasm', functionTypes: ['function_definition', 'lambda'] },
  { id: 'rust', displayName: 'Rust', extensions: ['.rs'], wasm: 'tree-sitter-rust.wasm', functionTypes: ['function_item', 'closure_expression'] , reflow: {  } },
  { id: 'ruby', displayName: 'Ruby', extensions: ['.rb'], wasm: 'tree-sitter-ruby.wasm', functionTypes: ['method', 'singleton_method'] },
  { id: 'php', displayName: 'PHP', extensions: ['.php'], wasm: 'tree-sitter-php.wasm', functionTypes: ['function_definition', 'method_declaration'], identifierTypes: ['name', 'variable_name'] },
  { id: 'kotlin', displayName: 'Kotlin', extensions: ['.kt', '.kts'], wasm: 'tree-sitter-kotlin.wasm', functionTypes: ['function_declaration'], identifierTypes: ['simple_identifier', 'type_identifier'] , reflow: {  } },
  { id: 'swift', displayName: 'Swift', extensions: ['.swift'], wasm: 'tree-sitter-swift.wasm', functionTypes: ['function_declaration'], identifierTypes: ['simple_identifier', 'type_identifier'] , reflow: {  } },
  { id: 'c', displayName: 'C', extensions: ['.c', '.h'], wasm: 'tree-sitter-c.wasm', functionTypes: ['function_definition'] , reflow: {  } },
  { id: 'cpp', displayName: 'C++', extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'], wasm: 'tree-sitter-cpp.wasm', functionTypes: ['function_definition', 'lambda_expression'] , reflow: {  } },
  { id: 'shell', displayName: 'Shell', extensions: ['.sh', '.bash'], wasm: 'tree-sitter-bash.wasm', functionTypes: ['function_definition'], identifierTypes: ['word', 'variable_name'] },
  { id: 'scala', displayName: 'Scala', extensions: ['.scala'], wasm: 'tree-sitter-scala.wasm', functionTypes: ['function_definition'] , reflow: {  } },
];

/** Packs without any native formatter (browser builds, or tools not installed). */
export function parserOnlyPacks(): LanguagePack[] {
  return TREE_SITTER_SPECS.map((s) => treeSitterPack(s));
}

/**
 * Packs with native formatters, picked from what is installed on this machine.
 * Languages whose formatter is missing still get parsing and analysis.
 */
let nativeCache: Promise<LanguagePack[]> | null = null;
export function nativePacks(): Promise<LanguagePack[]> {
  nativeCache ??= detectNativePacks();
  return nativeCache;
}

async function detectNativePacks(): Promise<LanguagePack[]> {
  const has = {
    gofmt: await available('gofmt', []),
    rustfmt: await available('rustfmt'),
    ruff: await available('ruff'),
    black: await available('black'),
    clang: await available('clang-format'),
    gjf: await available('google-java-format'),
    shfmt: await available('shfmt'),
  };
  return TREE_SITTER_SPECS.map((s) => {
    const spec: TreeSitterSpec = { ...s };
    switch (s.id) {
      case 'java':
        if (has.gjf) Object.assign(spec, { formatter: googleJavaFormatter(), equivalence: 'tokens' });
        else if (has.clang) Object.assign(spec, { formatter: clangFormatter('a.java'), equivalence: 'tokens' });
        break;
      case 'csharp':
        if (has.clang) Object.assign(spec, { formatter: clangFormatter('a.cs'), equivalence: 'tokens' });
        break;
      case 'c':
        if (has.clang) Object.assign(spec, { formatter: clangFormatter('a.c'), equivalence: 'tokens' });
        break;
      case 'cpp':
        if (has.clang) Object.assign(spec, { formatter: clangFormatter('a.cpp'), equivalence: 'tokens' });
        break;
      case 'go':
        if (has.gofmt) Object.assign(spec, { formatter: gofmtFormatter, equivalence: 'trust' });
        break;
      case 'rust':
        if (has.rustfmt) Object.assign(spec, { formatter: rustfmtFormatter, equivalence: 'trust' });
        break;
      case 'python':
        if (has.ruff) Object.assign(spec, { formatter: pythonFormatter(ruffFormatter), equivalence: 'trust' });
        else if (has.black) Object.assign(spec, { formatter: pythonFormatter(blackFormatter), equivalence: 'trust' });
        break;
      case 'shell':
        if (has.shfmt) Object.assign(spec, { formatter: shfmtFormatter, equivalence: 'trust' });
        break;
      default:
        break;
    }
    return treeSitterPack(spec);
  });
}
