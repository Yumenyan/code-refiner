import { basename, extname } from '../core/text.js';
import type { ProjectFile, ProjectMetadata, Suggestion } from '../core/types.js';
import type { FileModels } from '../semantic/model.js';
import type { ProjectModel } from '../semantic/project.js';

function wordCount(source: string, name: string): number {
  const re = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g');
  return (source.match(re) ?? []).length;
}

export function analyzeDeadCode(
  model: ProjectModel,
  texts: Map<string, string>,
  files: ProjectFile[],
  meta: ProjectMetadata,
  htmlHandlerNames: Set<string>,
): Suggestion[] {
  const out: Suggestion[] = [];

  for (const [file, m] of model.files as Map<string, FileModels>) {
    const s = m.semantic;
    if (!s) continue;
    const source = texts.get(file) ?? '';
    for (const v of s.variables) {
      if (v.exported || v.references.length > 0 || v.kind === 'param' || v.kind === 'catch') continue;
      if (v.name.startsWith('_')) continue;
      if (s.hasDynamicScope) continue;
      if (wordCount(source, v.name) > 1) {
        // Mentioned somewhere else in the file (type position, JSDoc, string, assignment): not provably unused.
        if (!(v.assignments > 0 && v.references.length === 0)) continue;
      }
      let confidence = 0.9;
      if (v.scopeKind === 'global') {
        // A classic-script global: another script or an HTML attribute may use it.
        if (htmlHandlerNames.has(v.name)) continue;
        let mentioned = false;
        for (const [other, ids] of model.identifiers) if (other !== file && ids.has(v.name)) mentioned = true;
        for (const [other, text] of texts) if (!mentioned && other !== file && text.includes(v.name) && (other.endsWith('.html') || other.endsWith('.htm'))) mentioned = true;
        if (mentioned) continue;
        confidence = 0.7;
      }
      const what = v.kind === 'import' ? 'import' : v.kind === 'function' ? 'function' : v.kind === 'class' ? 'class' : 'variable';
      out.push({
        file,
        kind: 'dead-code',
        loc: v.loc,
        confidence,
        message: `Unused ${what} "${v.name}"${v.assignments > 0 ? ' (assigned but never read)' : ''}.`,
        details: { category: `unused-${what}`, name: v.name },
      });
    }
    for (const u of s.unreachable) {
      out.push({ file, kind: 'dead-code', loc: u.loc, confidence: 0.95, message: `Unreachable code (${u.reason}).`, details: { category: 'unreachable' } });
    }
  }

  // Unreferenced files
  const entries = new Set(meta.entryPoints);
  const referencedByText = (path: string): boolean => {
    const base = basename(path);
    for (const [other, text] of texts) if (other !== path && text.includes(base)) return true;
    return false;
  };
  for (const f of files) {
    if (f.ignored || f.kind === 'binary' && !/\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|mp4|mp3)$/i.test(f.path)) continue;
    const ext = extname(f.path);
    if (!['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.woff', '.woff2', '.ttf', '.otf'].includes(ext)) continue;
    const base = basename(f.path);
    if (f.path.endsWith('.d.ts') || entries.has(f.path) || model.referencedFiles.has(f.path)) continue;
    if (/(^|\/)(index|main|app|server|cli)\.[cm]?[jt]sx?$/.test(f.path) || /\.(test|spec|config|setup)\.[cm]?[jt]sx?$/.test(base) || /(^|\/)(tests?|__tests__|scripts|bin|e2e)\//.test(f.path)) continue;
    if (/^(vite|webpack|rollup|jest|vitest|babel|eslint|prettier|tailwind|postcss|next|svelte|tsup)[.-]/.test(base) || base.startsWith('.')) continue;
    if (referencedByText(f.path)) continue;
    out.push({ file: f.path, kind: 'dead-code', confidence: 0.5, message: 'File is not referenced by any import, <script>, <link>, stylesheet, entry point or string in the project.', details: { category: 'unreferenced-file' } });
  }
  return out;
}
