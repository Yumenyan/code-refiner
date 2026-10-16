import { parse } from 'parse5';
import type { HtmlElementInfo, HtmlFileModel, HtmlHandlerInfo } from '../../semantic/model.js';
import type { Change, Loc } from '../../core/types.js';
import type { FormatterAdapter, LanguagePack, RefineInput, RefineOutput } from '../types.js';
import { analyzeCss } from '../css/pack.js';
import { analyzeEcma } from '../javascript/semantic.js';
import type { CssFileModel, FileModels, FileSemantic } from '../../semantic/model.js';

/* Minimal structural view of parse5's default tree. */
interface Attr { name: string; value: string }
interface SrcLoc {
  startOffset: number;
  endOffset: number;
  startLine: number;
  startCol: number;
  attrs?: Record<string, { startOffset: number; endOffset: number }>;
}
interface HNode {
  nodeName: string;
  tagName?: string;
  attrs?: Attr[];
  value?: string;
  childNodes?: HNode[];
  content?: HNode;
  sourceCodeLocation?: SrcLoc | null;
}

const JS_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'module', 'text/ecmascript', 'application/ecmascript']);
const CSS_TYPES = new Set(['', 'text/css']);

function parseHtml(source: string): HNode {
  return parse(source, { sourceCodeLocationInfo: true }) as unknown as HNode;
}

function walk(node: HNode, fn: (n: HNode) => void): void {
  fn(node);
  for (const c of node.childNodes ?? []) walk(c, fn);
  if (node.content) walk(node.content, fn);
}

const attr = (n: HNode, name: string) => n.attrs?.find((a) => a.name === name)?.value;
const locOf = (n: HNode): Loc => ({ line: n.sourceCodeLocation?.startLine ?? 0, column: n.sourceCodeLocation?.startCol ?? 0 });

const JS_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'function', 'typeof', 'catch', 'with', 'new', 'void']);
export function handlerCalls(code: string): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (!JS_KEYWORDS.has(m[1])) out.add(m[1]);
  }
  return [...out];
}

export function analyzeHtml(source: string, file: string): HtmlFileModel {
  const model: HtmlFileModel = { file, elements: [], handlers: [], scripts: [], styles: [], duplicateIds: [], refs: [] };
  const root = parseHtml(source);
  const seenIds = new Set<string>();
  walk(root, (n) => {
    if (!n.tagName) return;
    const id = attr(n, 'id');
    const classes = (attr(n, 'class') ?? '').split(/\s+/).filter(Boolean);
    const dataAttrs = (n.attrs ?? []).filter((a) => a.name.startsWith('data-')).map((a) => a.name);
    const el: HtmlElementInfo = { tag: n.tagName, id, classes, dataAttrs, loc: locOf(n) };
    model.elements.push(el);
    if (id) {
      if (seenIds.has(id)) model.duplicateIds.push(id);
      seenIds.add(id);
    }
    for (const a of n.attrs ?? []) {
      if (['src', 'href', 'poster', 'data-src', 'action'].includes(a.name) && a.value && !/^(https?:|\/\/|data:|mailto:|tel:|javascript:|#)/i.test(a.value)) model.refs.push(a.value.split(/[?#]/)[0]);
      if (a.name === 'srcset') for (const part of a.value.split(',')) { const u = part.trim().split(/\s+/)[0]; if (u && !/^(https?:|\/\/|data:)/i.test(u)) model.refs.push(u.split(/[?#]/)[0]); }
      if (/^on[a-z]+$/.test(a.name)) {
        const h: HtmlHandlerInfo = { event: a.name.slice(2), code: a.value, calls: handlerCalls(a.value), elementId: id, loc: locOf(n) };
        model.handlers.push(h);
      }
    }
    if (n.tagName === 'script') {
      const type = (attr(n, 'type') ?? '').toLowerCase();
      model.scripts.push({ src: attr(n, 'src'), inline: !attr(n, 'src'), module: type === 'module', loc: locOf(n) });
    } else if (n.tagName === 'style') model.styles.push({ inline: true, loc: locOf(n) });
    else if (n.tagName === 'link' && (attr(n, 'rel') ?? '').toLowerCase().includes('stylesheet')) model.styles.push({ href: attr(n, 'href'), inline: false, loc: locOf(n) });
  });
  return model;
}

interface Segment {
  kind: 'js' | 'css';
  start: number;
  end: number;
  isModule: boolean;
}

function findSegments(root: HNode): Segment[] {
  const segs: Segment[] = [];
  walk(root, (n) => {
    if (n.tagName !== 'script' && n.tagName !== 'style') return;
    const text = n.childNodes?.[0];
    if (!text || text.nodeName !== '#text' || !text.sourceCodeLocation) return;
    const type = (attr(n, 'type') ?? '').toLowerCase().split(';')[0].trim();
    if (n.tagName === 'script') {
      if (attr(n, 'src') !== undefined || !JS_TYPES.has(type)) return;
      segs.push({ kind: 'js', start: text.sourceCodeLocation.startOffset, end: text.sourceCodeLocation.endOffset, isModule: type === 'module' });
    } else if (CSS_TYPES.has(type)) {
      segs.push({ kind: 'css', start: text.sourceCodeLocation.startOffset, end: text.sourceCodeLocation.endOffset, isModule: false });
    }
  });
  return segs;
}

/** Redundant `type` attributes which browsers ignore (script/style defaults). Returns [start,end,label]. */
function redundantTypeAttrs(root: HNode, source: string): [number, number, string][] {
  const out: [number, number, string][] = [];
  walk(root, (n) => {
    if (!n.tagName || !n.sourceCodeLocation?.attrs) return;
    const type = attr(n, 'type');
    if (type === undefined) return;
    const t = type.toLowerCase();
    const redundant =
      (n.tagName === 'script' && (t === 'text/javascript' || t === 'application/javascript')) ||
      (n.tagName === 'style' && t === 'text/css') ||
      (n.tagName === 'link' && t === 'text/css' && (attr(n, 'rel') ?? '').toLowerCase() === 'stylesheet');
    if (!redundant) return;
    const loc = n.sourceCodeLocation.attrs['type'];
    if (!loc) return;
    let start = loc.startOffset;
    while (start > 0 && /\s/.test(source[start - 1])) start--;
    out.push([start, loc.endOffset, `<${n.tagName} type="${type}">`]);
  });
  return out;
}

/** Order-insensitive structural fingerprint used to prove formatting kept the document intact. */
function signature(source: string): string {
  const root = parseHtml(source);
  const parts: string[] = [];
  const normAttr = (name: string, v: string) => {
    let s = v.replace(/\s+/g, ' ').trim();
    if (name === 'style' || /^on[a-z]+$/.test(name)) s = s.replace(/\s*([:;,(){}])\s*/g, '$1').replace(/;+$/, '').replace(/["']/g, '"');
    return s;
  };
  const rec = (n: HNode, depth: number): void => {
    if (n.nodeName === '#text') {
      const t = (n.value ?? '').replace(/\s+/g, ' ').trim();
      if (t) parts.push(`${depth}t:${t}`);
      return;
    }
    if (n.nodeName === '#comment') return;
    if (n.tagName) {
      const attrs = (n.attrs ?? [])
        .filter((a) => !(a.name === 'type' && /^(text\/javascript|application\/javascript|text\/css)$/i.test(a.value)))
        .map((a) => `${a.name}=${normAttr(a.name, a.value)}`)
        .sort()
        .join(',');
      parts.push(`${depth}<${n.tagName} ${attrs}>`);
      if (n.tagName === 'script' || n.tagName === 'style' || n.tagName === 'pre' || n.tagName === 'textarea') {
        if (n.tagName === 'pre' || n.tagName === 'textarea') parts.push(`${depth + 1}raw:${(n.childNodes ?? []).map((c) => c.value ?? '').join('')}`);
        return; // script/style bodies are validated by their own language packs
      }
    }
    for (const c of n.childNodes ?? []) rec(c, depth + 1);
    if (n.content) rec(n.content, depth + 1);
  };
  rec(root, 0);
  return parts.join('\n');
}

function lineOffsetAt(source: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

export function htmlPack(formatter: FormatterAdapter): LanguagePack {
  return {
    id: 'html',
    displayName: 'HTML',
    extensions: ['.html', '.htm'],
    formatter,
    rules: [{ id: 'html-redundant-type-attr', description: 'Removes type="text/javascript" / type="text/css" (browser defaults)', level: 'safe' }],
    checkSyntax(source) {
      try {
        parseHtml(source);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    analyze({ file, source }) {
      try {
        const models: FileModels = { html: analyzeHtml(source, file) };
        const segs = findSegments(parseHtml(source));
        const sems: FileSemantic[] = [];
        const csss: CssFileModel[] = [];
        segs.forEach((seg, i) => {
          const text = source.slice(seg.start, seg.end);
          const base = lineOffsetAt(source, seg.start);
          if (seg.kind === 'js') {
            const sem = analyzeEcma(text, `${file}#script${i}${seg.isModule ? '.mjs' : '.js'}`, 'javascript');
            if (!('error' in sem)) sems.push(shiftSemantic(sem, file, base));
          } else {
            const css = analyzeCss(text, file);
            if (css) csss.push(shiftCss(css, base));
          }
        });
        if (sems.length) models.semantic = mergeSemantics(file, sems);
        if (csss.length) models.css = mergeCss(file, csss);
        return models;
      } catch {
        return {};
      }
    },
    async refine(input: RefineInput): Promise<RefineOutput> {
      const { file, project } = input;
      const out: RefineOutput = { code: input.source, changes: [], suggestions: [], warnings: [] };
      let current = input.source;
      const warn = (code: string, message: string) => out.warnings.push({ code, message, file });

      // 1. Embedded <script>/<style> -> their own Language Packs.
      if (project.refineEmbedded) {
        const segments = findSegments(parseHtml(current)).sort((a, b) => b.start - a.start);
        for (const seg of segments) {
          const fragment = current.slice(seg.start, seg.end);
          if (!fragment.trim()) continue;
          const lang = seg.kind === 'js' ? 'javascript' : 'css';
          try {
            const res = await project.refineEmbedded(lang, fragment, { file, isModule: seg.isModule });
            const baseLine = lineOffsetAt(current, seg.start);
            const shift = (c: Change): Change => ({ ...c, file, loc: c.loc ? { line: c.loc.line + baseLine, column: c.loc.column } : c.loc });
            out.changes.push(...res.changes.filter((c) => c.kind !== 'format').map(shift));
            out.suggestions.push(...res.suggestions.map((s) => ({ ...s, file, loc: s.loc ? { line: s.loc.line + baseLine, column: s.loc.column } : s.loc })));
            out.warnings.push(...res.warnings.map((w) => ({ ...w, file })));
            current = current.slice(0, seg.start) + res.code + current.slice(seg.end);
          } catch (e) {
            warn('embedded-failed', `Inline ${lang} left untouched: ${(e as Error).message}`);
          }
        }
      }

      // 2. Redundant type attributes.
      {
        const attrs = redundantTypeAttrs(parseHtml(current), current).sort((a, b) => b[0] - a[0]);
        if (attrs.length && input.config.mode) {
          for (const [s, e, label] of attrs) {
            out.changes.push({ file, kind: 'markup', ruleId: 'html-redundant-type-attr', level: 'safe', description: `Removed redundant type attribute on ${label}`, loc: { line: lineOffsetAt(current, s) + 1, column: 1 }, before: current.slice(s, e).trim(), confidence: 1 });
            current = current.slice(0, s) + current.slice(e);
          }
        }
      }

      // 3. Format, then prove the document structure is unchanged.
      try {
        const formatted = await formatter.format(current, file);
        if (signature(formatted) === signature(current)) current = formatted;
        else warn('format-skipped', 'Formatter output changed the document structure; left unformatted');
      } catch (e) {
        warn('format-failed', (e as Error).message.split('\n')[0]);
      }
      out.code = current;
      if (current !== input.source) out.changes.push({ file, kind: 'format', ruleId: 'format', level: 'safe', description: `Formatted (${formatter.id})`, confidence: 1 });
      return out;
    },
    isEquivalent(a, b) {
      try {
        return signature(a) === signature(b);
      } catch {
        return undefined;
      }
    },
  };
}

// ---- Embedded fragment model helpers ---------------------------------------------------------------

function shiftLoc<T extends { line: number }>(l: T, by: number): T {
  return { ...l, line: l.line + by };
}

function shiftSemantic(sem: FileSemantic, file: string, by: number): FileSemantic {
  return {
    ...sem,
    file,
    variables: sem.variables.map((v) => ({ ...v, file, loc: shiftLoc(v.loc, by), references: v.references.map((r) => shiftLoc(r, by)) })),
    functions: sem.functions.map((f) => ({ ...f, file, loc: shiftLoc(f.loc, by) })),
    module: {
      ...sem.module,
      file,
      imports: sem.module.imports.map((i) => ({ ...i, loc: shiftLoc(i.loc, by) })),
      exports: sem.module.exports.map((e) => ({ ...e, loc: shiftLoc(e.loc, by) })),
    },
    dataFlow: sem.dataFlow.map((d) => ({ ...d, file, loc: shiftLoc(d.loc, by) })),
    calls: sem.calls.map((c) => ({ ...c, file, loc: shiftLoc(c.loc, by) })),
    domRefs: sem.domRefs.map((d) => ({ ...d, file, loc: shiftLoc(d.loc, by) })),
    unreachable: sem.unreachable.map((u) => ({ ...u, file, loc: shiftLoc(u.loc, by) })),
    functionHashes: sem.functionHashes.map((h) => ({ ...h, loc: shiftLoc(h.loc, by) })),
  };
}

function mergeSemantics(file: string, parts: FileSemantic[]): FileSemantic {
  const counts: Record<string, number> = {};
  for (const p of parts) for (const [k, v] of Object.entries(p.identifierCounts)) counts[k] = (counts[k] ?? 0) + v;
  return {
    file,
    language: 'javascript',
    variables: parts.flatMap((p) => p.variables),
    functions: parts.flatMap((p) => p.functions),
    module: { file, isModule: parts.some((p) => p.module.isModule), imports: parts.flatMap((p) => p.module.imports), exports: parts.flatMap((p) => p.module.exports) },
    dataFlow: parts.flatMap((p) => p.dataFlow),
    calls: parts.flatMap((p) => p.calls),
    domRefs: parts.flatMap((p) => p.domRefs),
    unreachable: parts.flatMap((p) => p.unreachable),
    strings: parts.flatMap((p) => p.strings),
    functionHashes: parts.flatMap((p) => p.functionHashes),
    hasDynamicScope: parts.some((p) => p.hasDynamicScope),
    identifierCounts: counts,
  };
}

function shiftCss(css: CssFileModel, by: number): CssFileModel {
  return {
    ...css,
    selectors: css.selectors.map((s) => ({ ...s, loc: shiftLoc(s.loc, by) })),
    customPropsDeclared: css.customPropsDeclared.map((p) => ({ ...p, loc: shiftLoc(p.loc, by) })),
    keyframes: css.keyframes.map((k) => ({ ...k, loc: shiftLoc(k.loc, by) })),
    blockHashes: css.blockHashes.map((b) => ({ ...b, loc: shiftLoc(b.loc, by) })),
  };
}

function mergeCss(file: string, parts: CssFileModel[]): CssFileModel {
  return {
    file,
    selectors: parts.flatMap((p) => p.selectors),
    customPropsDeclared: parts.flatMap((p) => p.customPropsDeclared),
    customPropsUsed: parts.flatMap((p) => p.customPropsUsed),
    keyframes: parts.flatMap((p) => p.keyframes),
    animationNamesUsed: parts.flatMap((p) => p.animationNamesUsed),
    imports: parts.flatMap((p) => p.imports),
    blockHashes: parts.flatMap((p) => p.blockHashes),
  };
}
