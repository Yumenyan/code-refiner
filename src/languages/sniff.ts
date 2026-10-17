import type { LanguageRegistry } from './registry.js';
import type { LanguagePack } from './types.js';

/** Cheap content hints per language. Several matches *and* a clean parse are needed to pick a language. */
const HINTS: Record<string, RegExp[]> = {
  javascript: [/\bfunction\s*[\w$]*\s*\(/, /=>/, /\b(var|let|const)\s+[\w$]+\s*=/, /\bdocument\.|\bwindow\.|\bconsole\.log\b/, /\brequire\s*\(|module\.exports|\bimport\s.+\sfrom\b/, /^#!.*\bnode\b/m, /\bprototype\b|\bnew\s+\w+\(/],
  typescript: [/:\s*(string|number|boolean|any|void)\b/, /\binterface\s+\w+/, /\bimplements\b/, /\benum\s+\w+/, /\bas\s+(string|number|any|unknown)\b/],
  rust: [/\bfn\s+\w+\s*[<(]/, /\blet\s+(mut\s+)?\w+/, /\bimpl\b/, /\bpub\s+(fn|struct|enum|mod)\b/, /\w::\w/, /\bprintln!\(/, /\buse\s+\w+(::\w+)+/, /->\s*\w+\s*\{/],
  java: [/\bpublic\s+(static\s+)?(final\s+)?(class|void|int|String)\b/, /\bSystem\.out\./, /\bimport\s+java\./, /\bpackage\s+[\w.]+;/, /@Override/],
  csharp: [/\busing\s+System/, /\bnamespace\s+[\w.]+/, /\bConsole\.Write/, /\bpublic\s+(static\s+)?(class|void|int|string)\b/, /\bvar\s+\w+\s*=\s*new\b/],
  go: [/^package\s+\w+/m, /\bfunc\s+(\(\w+\s+\*?\w+\)\s*)?\w+\s*\(/, /\w+\s*:=\s*/, /\bfmt\.\w+\(/, /\bgo\s+func\b|\bdefer\b/],
  python: [/^\s*def\s+\w+\(.*\)\s*(->.*)?:/m, /^(from\s+\w+\s+)?import\s+\w+/m, /^\s+self\./m, /\bprint\(/, /^class\s+\w+.*:/m, /^\s*elif\b|^\s*if\s+__name__/m],
  php: [/<\?php/, /\$\w+\s*=/, /\bfunction\s+\w+\s*\(.*\$/, /->\w+\(/],
  ruby: [/^\s*def\s+\w+/m, /^\s*end\s*$/m, /\bputs\b/, /\battr_(reader|accessor)\b|\brequire\s+['"]/],
  kotlin: [/\bfun\s+\w+\s*\(/, /\bval\s+\w+/, /\bvar\s+\w+\s*:\s*\w+/, /\bdata\s+class\b/],
  swift: [/\bfunc\s+\w+\s*\(/, /\blet\s+\w+\s*(:\s*\w+)?\s*=/, /\bguard\s+let\b/, /\bimport\s+(Foundation|UIKit|SwiftUI)\b/],
  c: [/#include\s*[<"]/, /\bint\s+main\s*\(/, /\bprintf\s*\(/, /\btypedef\s+struct\b/],
  cpp: [/#include\s*<(iostream|vector|string|map)>/, /\bstd::\w+/, /\bnamespace\s+\w+\s*\{/, /\btemplate\s*</],
  shell: [/^#!.*\b(ba|z)?sh\b/m, /^\s*fi\s*$/m, /\$\{?\w+\}?/, /\becho\s+/],
  scala: [/\bobject\s+\w+/, /\bdef\s+\w+\s*\(.*\)\s*:\s*\w+\s*=/, /\bcase\s+class\b/],
};

/** Extensions that are never source code (never sniffed). */
const NEVER = /\.(md|markdown|txt|csv|tsv|log|lock|map|svg|xml|toml|ini|cfg|env|properties|gitignore|gitattributes|editorconfig|license|pem|key|crt|sql|rst|tex)$/i;

export function mightBeSource(path: string): boolean {
  return !NEVER.test(path) && !/(^|\/)(LICENSE|README|CHANGELOG|NOTICE|Makefile|Dockerfile)$/i.test(path);
}

/**
 * Picks the Language Pack whose hints match most and whose parser accepts the text.
 * Returns undefined when nothing is convincing - the file is then left alone.
 */
export async function sniffLanguage(path: string, text: string, registry: LanguageRegistry): Promise<LanguagePack | undefined> {
  if (!mightBeSource(path) || text.length < 20 || text.length > 2_000_000) return undefined;
  const scored = Object.entries(HINTS)
    .map(([id, res]) => ({ id, score: res.filter((r) => r.test(text)).length }))
    .filter((x) => x.score >= 2 || (x.score === 1 && /^#!|<\?php/.test(text)))
    .sort((a, b) => b.score - a.score);
  for (const { id } of scored.slice(0, 4)) {
    const pack = registry.get(id);
    if (!pack) continue;
    try {
      await pack.init?.();
      if ((await pack.checkSyntax(text, path)).ok) return pack;
    } catch {
      /* try the next candidate */
    }
  }
  return undefined;
}
