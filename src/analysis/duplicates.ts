import { fingerprint } from '../core/text.js';
import type { Suggestion } from '../core/types.js';
import type { FileModels } from '../semantic/model.js';

const WINDOW = 8;

function normalizeLine(l: string): string {
  return l.trim().replace(/\s+/g, ' ');
}
const TRIVIAL = /^([{}()[\];,]|\}\)?;?|\]\)?;?|\)\)?;?|else \{|\} else \{|\/\/.*|\/\*.*|\*.*)$/;

interface Occ {
  file: string;
  start: number;
  end: number;
}

export function detectDuplicates(models: Map<string, FileModels>, texts: Map<string, string>): Suggestion[] {
  const out: Suggestion[] = [];

  // 1. Structurally identical functions (names and literal values ignored).
  const byHash = new Map<string, { file: string; name: string; line: number; lines: number; size: number }[]>();
  for (const [file, m] of models) {
    for (const f of m.semantic?.functionHashes ?? []) {
      const list = byHash.get(f.hash) ?? [];
      list.push({ file, name: f.name, line: f.loc.line, lines: f.lines, size: f.size });
      byHash.set(f.hash, list);
    }
  }
  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    const g = group.sort((a, b) => (a.file + a.line < b.file + b.line ? -1 : 1));
    out.push({
      file: g[0].file,
      kind: 'duplicate',
      loc: { line: g[0].line, column: 1 },
      confidence: 0.9,
      message: `${g.length} functions have the same structure: ${g.map((x) => `${x.name} (${x.file}:${x.line})`).join(', ')}.`,
      details: { category: 'duplicate-function', locations: g.map((x) => ({ file: x.file, line: x.line, name: x.name })), size: g[0].size },
    });
  }

  // 2. Identical CSS declaration blocks under different selectors.
  const cssBlocks = new Map<string, { file: string; selector: string; line: number; decls: number }[]>();
  for (const [file, m] of models) {
    for (const b of m.css?.blockHashes ?? []) {
      const list = cssBlocks.get(b.hash) ?? [];
      list.push({ file, selector: b.selector, line: b.loc.line, decls: b.decls });
      cssBlocks.set(b.hash, list);
    }
  }
  for (const group of cssBlocks.values()) {
    if (group.length < 2 || group[0].decls < 3) continue;
    out.push({
      file: group[0].file,
      kind: 'duplicate',
      loc: { line: group[0].line, column: 1 },
      confidence: 0.85,
      message: `${group.length} CSS rules declare exactly the same ${group[0].decls} properties: ${group.map((x) => x.selector).join(' | ')}. They could share one rule.`,
      details: { category: 'duplicate-css', locations: group.map((x) => ({ file: x.file, line: x.line, selector: x.selector })) },
    });
  }

  // 3. Repeated line windows (copy & paste), ignoring whitespace.
  const windows = new Map<string, Occ[]>();
  for (const [file, text] of texts) {
    if (!/\.(m?[jt]sx?|cjs|css|html?)$/i.test(file)) continue;
    const raw = text.split('\n');
    const kept: { line: number; text: string }[] = [];
    raw.forEach((l, i) => {
      const n = normalizeLine(l);
      if (n && !TRIVIAL.test(n)) kept.push({ line: i + 1, text: n });
    });
    for (let i = 0; i + WINDOW <= kept.length; i++) {
      const slice = kept.slice(i, i + WINDOW);
      if (slice.reduce((a, b) => a + b.text.length, 0) < WINDOW * 12) continue;
      const h = fingerprint(slice.map((x) => x.text).join('\n'));
      const list = windows.get(h) ?? [];
      list.push({ file, start: slice[0].line, end: slice[slice.length - 1].line });
      windows.set(h, list);
    }
  }
  // merge windows into ranges per occurrence cluster
  const seen = new Set<string>();
  const clusters: { occs: Occ[]; lines: number }[] = [];
  for (const [, occs] of windows) {
    if (occs.length < 2) continue;
    // ignore same-file overlapping hits
    const distinct = occs.filter((o, i) => occs.findIndex((p) => p.file === o.file && Math.abs(p.start - o.start) < WINDOW) === i);
    if (distinct.length < 2) continue;
    const key = distinct.map((o) => `${o.file}:${Math.floor(o.start / WINDOW)}`).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    clusters.push({ occs: distinct, lines: WINDOW });
  }
  // Coalesce clusters whose first occurrence overlaps/touches a previous one (same files, consecutive lines).
  clusters.sort((a, b) => (a.occs[0].file + String(a.occs[0].start).padStart(8, '0') < b.occs[0].file + String(b.occs[0].start).padStart(8, '0') ? -1 : 1));
  const merged: { occs: Occ[]; lines: number }[] = [];
  for (const c of clusters) {
    const prev = merged[merged.length - 1];
    if (prev && prev.occs.length === c.occs.length && prev.occs.every((o, i) => o.file === c.occs[i].file && c.occs[i].start <= o.end + 2 && c.occs[i].start >= o.start)) {
      prev.occs.forEach((o, i) => (o.end = Math.max(o.end, c.occs[i].end)));
      prev.lines = prev.occs[0].end - prev.occs[0].start + 1;
    } else merged.push({ occs: c.occs.map((o) => ({ ...o })), lines: c.lines });
  }
  const functionDupLocs = new Set(out.flatMap((s) => ((s.details?.locations as { file: string; line: number }[]) ?? []).map((l) => `${l.file}:${l.line}`)));
  for (const c of merged) {
    if (c.occs.some((o) => functionDupLocs.has(`${o.file}:${o.start}`))) continue;
    out.push({
      file: c.occs[0].file,
      kind: 'duplicate',
      loc: { line: c.occs[0].start, column: 1 },
      confidence: 0.7,
      message: `Similar ${c.lines}-line block appears ${c.occs.length} times: ${c.occs.map((o) => `${o.file}:${o.start}-${o.end}`).join(', ')}.`,
      details: { category: 'duplicate-block', locations: c.occs.map((o) => ({ file: o.file, line: o.start, endLine: o.end })) },
    });
  }
  return out.slice(0, 200);
}
