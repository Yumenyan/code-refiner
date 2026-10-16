import { extname, posixDirname, posixJoin } from '../core/text.js';
import type { CallEdge, DataFlowEdge, FileModels, FileSemantic, FunctionInfo } from './model.js';

export interface DependencyEdge {
  from: string;
  to: string;
  kind: 'import' | 'script' | 'stylesheet' | 'css-import' | 'asset';
}

export interface ProjectModel {
  files: Map<string, FileModels>;
  dependencies: DependencyEdge[];
  /** Strongly connected groups of files (circular dependencies). */
  cycles: string[][];
  functions: FunctionInfo[];
  /** Call graph with cross-file imports resolved where possible. */
  callGraph: CallEdge[];
  dataFlow: DataFlowEdge[];
  /** Per-file identifier sets, for "is this name mentioned elsewhere" checks. */
  identifiers: Map<string, Set<string>>;
  /** Files that something references (imports, <script src>, CSS @import, assets...). */
  referencedFiles: Set<string>;
  unresolvedImports: { file: string; source: string }[];
}

const RESOLVE_EXT = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.json', '.css'];

export function resolveRelative(from: string, spec: string, files: Set<string>): string | undefined {
  if (!(spec.startsWith('.') || spec.startsWith('/'))) return undefined;
  const clean = spec.split(/[?#]/)[0];
  const base = clean.startsWith('/') ? posixJoin(clean) : posixJoin(posixDirname(from), clean);
  const candidates = [base];
  // TS projects import './x.js' for './x.ts'
  const ext = extname(base);
  if (['.js', '.mjs', '.cjs', '.jsx'].includes(ext)) {
    const stem = base.slice(0, -ext.length);
    candidates.push(stem + '.ts', stem + '.tsx', stem + '.mts', stem + '.cts');
  }
  for (const e of RESOLVE_EXT) candidates.push(base + e);
  for (const e of RESOLVE_EXT) candidates.push(posixJoin(base, 'index' + e));
  return candidates.find((c) => files.has(c));
}

export function buildProjectModel(models: Map<string, FileModels>, filePaths: Set<string>): ProjectModel {
  const dependencies: DependencyEdge[] = [];
  const unresolvedImports: { file: string; source: string }[] = [];
  const referencedFiles = new Set<string>();
  const functions: FunctionInfo[] = [];
  const dataFlow: DataFlowEdge[] = [];
  const identifiers = new Map<string, Set<string>>();
  const exportsByFile = new Map<string, Map<string, FunctionInfo>>();
  const fnByFileName = new Map<string, FunctionInfo[]>();

  const link = (from: string, spec: string, kind: DependencyEdge['kind']): string | undefined => {
    const to = resolveRelative(from, spec, filePaths);
    if (to) {
      dependencies.push({ from, to, kind });
      referencedFiles.add(to);
    } else if (spec.startsWith('.') && kind === 'import') {
      unresolvedImports.push({ file: from, source: spec });
    }
    return to;
  };

  for (const [file, m] of models) {
    if (m.semantic) {
      const s = m.semantic;
      identifiers.set(file, new Set(Object.keys(s.identifierCounts)));
      functions.push(...s.functions);
      dataFlow.push(...s.dataFlow);
      fnByFileName.set(file, s.functions);
      for (const imp of s.module.imports) imp.resolved = link(file, imp.source, 'import');
    }
    if (m.html) {
      for (const sc of m.html.scripts) if (sc.src) link(file, resolveHtmlRef(file, sc.src), 'script');
      for (const st of m.html.styles) if (st.href) link(file, resolveHtmlRef(file, st.href), 'stylesheet');
      for (const r of m.html.refs) link(file, resolveHtmlRef(file, r), 'asset');
    }
    if (m.css) for (const i of m.css.imports) link(file, i.startsWith('.') || i.startsWith('/') ? i : './' + i, i.match(/\.css$/i) ? 'css-import' : 'asset');
  }

  // Export tables for cross-file call resolution.
  for (const [file, m] of models) {
    if (!m.semantic) continue;
    const table = new Map<string, FunctionInfo>();
    for (const fn of m.semantic.functions) if (fn.exported) table.set(fn.name, fn);
    exportsByFile.set(file, table);
  }

  const callGraph: CallEdge[] = [];
  for (const [file, m] of models) {
    if (!m.semantic) continue;
    const imports = new Map(m.semantic.module.imports.flatMap((i) => i.specifiers.map((s) => [s.local, { imp: i, imported: s.imported }] as const)));
    for (const c of m.semantic.calls) {
      let callee = c.callee;
      if (callee.startsWith('import:')) {
        const hit = imports.get(callee.slice('import:'.length));
        const target = hit?.imp.resolved ? exportsByFile.get(hit.imp.resolved)?.get(hit.imported === 'default' ? 'default' : hit.imported) : undefined;
        const byName = hit?.imp.resolved ? fnByFileName.get(hit.imp.resolved)?.find((f) => f.name === hit.imported) : undefined;
        callee = (target ?? byName)?.id ?? `?${hit?.imported ?? callee}`;
      }
      callGraph.push({ ...c, callee });
    }
  }

  return {
    files: models,
    dependencies,
    cycles: findCycles(dependencies.filter((d) => d.kind === 'import' || d.kind === 'css-import')),
    functions,
    callGraph,
    dataFlow,
    identifiers,
    referencedFiles,
    unresolvedImports,
  };
}

/** HTML references are relative to the document unless they start with `/`. */
function resolveHtmlRef(from: string, ref: string): string {
  return ref.startsWith('/') || ref.startsWith('.') ? ref : './' + ref;
}

/** Tarjan's strongly connected components; returns groups with more than one file (or a self-loop). */
export function findCycles(edges: DependencyEdge[]): string[][] {
  const graph = new Map<string, string[]>();
  for (const e of edges) {
    if (!graph.has(e.from)) graph.set(e.from, []);
    graph.get(e.from)!.push(e.to);
    if (!graph.has(e.to)) graph.set(e.to, []);
  }
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const result: string[][] = [];
  const strong = (v: string): void => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!idx.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1 || (graph.get(v) ?? []).includes(v)) result.push(comp.sort());
    }
  };
  for (const v of [...graph.keys()].sort()) if (!idx.has(v)) strong(v);
  return result.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

export function callTree(model: ProjectModel, rootId: string, depth = 4): string[] {
  const names = new Map(model.functions.map((f) => [f.id, f.name]));
  const byCaller = new Map<string, string[]>();
  for (const c of model.callGraph) {
    if (!byCaller.has(c.caller)) byCaller.set(c.caller, []);
    const list = byCaller.get(c.caller)!;
    if (!list.includes(c.callee)) list.push(c.callee);
  }
  const lines: string[] = [];
  const visit = (id: string, prefix: string, d: number, seen: Set<string>): void => {
    const kids = (byCaller.get(id) ?? []).filter((k) => names.has(k));
    kids.forEach((k, i) => {
      const last = i === kids.length - 1;
      lines.push(`${prefix}${last ? '└─' : '├─'} ${names.get(k)}`);
      if (d > 1 && !seen.has(k)) visit(k, prefix + (last ? '   ' : '│  '), d - 1, new Set(seen).add(k));
    });
  };
  lines.push(names.get(rootId) ?? rootId);
  visit(rootId, '', depth, new Set([rootId]));
  return lines;
}

export type { FileSemantic };
