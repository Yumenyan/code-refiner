import type { Suggestion } from '../core/types.js';
import type { CssFileModel, DomRef, FileModels, HtmlFileModel } from '../semantic/model.js';

export interface CrossRefModel {
  /** HTML ids with everything that touches them. */
  ids: { id: string; html: { file: string; line: number }[]; css: { file: string; selector: string; line: number }[]; js: { file: string; line: number }[]; events: { event: string; handler?: string; file: string; line: number }[] }[];
  classes: { name: string; html: number; css: { file: string; selector: string; line: number }[]; js: { file: string; line: number }[] }[];
  /** event wiring: element -> event -> handler */
  events: { source: 'js' | 'html'; target?: string; event: string; handler?: string; file: string; line: number }[];
  /** Global names HTML relies on (inline handlers, window.x). */
  protectedNames: string[];
  suggestions: Suggestion[];
}

const BUILTIN_CALLABLES = new Set([
  'alert', 'confirm', 'prompt', 'console', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'event', 'this',
  'if', 'return', 'window', 'document', 'history', 'location', 'navigator', 'fetch', 'parseInt', 'parseFloat', 'String',
  'Number', 'Boolean', 'JSON', 'Math', 'Date', 'Array', 'Object', 'open', 'close', 'print', 'focus', 'blur',
  'submit', 'reset', 'toggle', 'scrollTo', 'requestAnimationFrame', 'eval', 'void', 'typeof', 'true', 'false', 'null',
  'undefined', 'select', 'click', 'stopPropagation', 'preventDefault', 'getElementById', 'querySelector', 'classList',
]);

function identifiers(code: string): string[] {
  return [...code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
}

export function analyzeCrossReferences(models: Map<string, FileModels>): CrossRefModel {
  const htmls: HtmlFileModel[] = [];
  const csss: CssFileModel[] = [];
  const domRefs: DomRef[] = [];
  const globalNames = new Set<string>();
  const strings: string[] = [];
  for (const m of models.values()) {
    if (m.html) htmls.push(m.html);
    if (m.css) csss.push(m.css);
    if (m.semantic) {
      domRefs.push(...m.semantic.domRefs);
      strings.push(...m.semantic.strings);
      for (const v of m.semantic.variables) if (v.scopeKind === 'global' && v.kind !== 'param') globalNames.add(v.name);
      for (const r of m.semantic.domRefs) if (r.kind === 'handler-global') globalNames.add(r.value);
    }
  }

  const protectedNames = new Set<string>();
  const events: CrossRefModel['events'] = [];
  const suggestions: Suggestion[] = [];

  const htmlIds = new Set<string>();
  const htmlClasses = new Map<string, number>();
  const htmlData = new Set<string>();
  const htmlTags = new Set<string>();
  for (const h of htmls) {
    for (const el of h.elements) {
      if (el.id) htmlIds.add(el.id);
      htmlTags.add(el.tag);
      for (const c of el.classes) htmlClasses.set(c, (htmlClasses.get(c) ?? 0) + 1);
      for (const d of el.dataAttrs) htmlData.add(d);
    }
    for (const hd of h.handlers) {
      for (const n of identifiers(hd.code)) protectedNames.add(n);
      events.push({ source: 'html', target: hd.elementId ? `#${hd.elementId}` : undefined, event: hd.event, handler: hd.calls[0], file: h.file, line: hd.loc.line });
      for (const call of hd.calls) {
        if (!BUILTIN_CALLABLES.has(call) && !globalNames.has(call)) {
          suggestions.push({ file: h.file, kind: 'cross-reference', loc: hd.loc, confidence: 0.7, message: `Inline on${hd.event} handler calls ${call}(), but no global function "${call}" was found in the project's scripts.` });
        }
      }
    }
    for (const id of h.duplicateIds) {
      suggestions.push({ file: h.file, kind: 'cross-reference', confidence: 0.95, message: `Duplicate HTML id "${id}" (ids must be unique).` });
    }
  }
  for (const r of domRefs) {
    if (r.kind === 'handler-global') protectedNames.add(r.value);
    if (r.kind === 'event') events.push({ source: 'js', target: r.target, event: r.event ?? r.value, handler: r.handler, file: r.file, line: r.loc.line });
  }

  const jsClassTokens = new Set<string>();
  for (const s of strings) for (const tok of s.split(/[^\w-]+/)) if (tok) jsClassTokens.add(tok);
  const jsRefClasses = new Map<string, { file: string; line: number }[]>();
  const jsRefIds = new Map<string, { file: string; line: number }[]>();
  for (const r of domRefs) {
    const bucket = r.kind === 'class' ? jsRefClasses : r.kind === 'id' ? jsRefIds : null;
    if (!bucket) continue;
    if (!bucket.has(r.value)) bucket.set(r.value, []);
    bucket.get(r.value)!.push({ file: r.file, line: r.loc.line });
  }

  const cssByClass = new Map<string, { file: string; selector: string; line: number }[]>();
  const cssById = new Map<string, { file: string; selector: string; line: number }[]>();
  const hasHtml = htmls.length > 0;
  for (const c of csss) {
    for (const sel of c.selectors) {
      for (const cls of sel.classes) {
        if (!cssByClass.has(cls)) cssByClass.set(cls, []);
        cssByClass.get(cls)!.push({ file: c.file, selector: sel.selector, line: sel.loc.line });
      }
      for (const id of sel.ids) {
        if (!cssById.has(id)) cssById.set(id, []);
        cssById.get(id)!.push({ file: c.file, selector: sel.selector, line: sel.loc.line });
      }
      if (!hasHtml || sel.opaque) continue;
      const missingClass = sel.classes.find((cls) => !htmlClasses.has(cls) && !jsRefClasses.has(cls) && !jsClassTokens.has(cls));
      const missingId = sel.ids.find((id) => !htmlIds.has(id) && !jsRefIds.has(id) && !jsClassTokens.has(id));
      if (missingClass || missingId) {
        suggestions.push({
          file: c.file,
          kind: 'dead-code',
          loc: sel.loc,
          confidence: 0.75,
          message: `Unused CSS selector "${sel.selector}": ${missingClass ? `class "${missingClass}"` : `id "${missingId}"`} appears in no HTML or script string.`,
          details: { category: 'unused-css' },
        });
      }
    }
    // custom properties and keyframes
    const used = new Set(csss.flatMap((x) => x.customPropsUsed));
    for (const p of c.customPropsDeclared) {
      if (!used.has(p.name) && !jsClassTokens.has(p.name)) {
        suggestions.push({ file: c.file, kind: 'dead-code', loc: p.loc, confidence: 0.6, message: `CSS custom property ${p.name} is declared but never used via var().`, details: { category: 'unused-css' } });
      }
    }
    const animUsed = new Set(csss.flatMap((x) => x.animationNamesUsed));
    for (const k of c.keyframes) {
      if (!animUsed.has(k.name) && !jsClassTokens.has(k.name)) {
        suggestions.push({ file: c.file, kind: 'dead-code', loc: k.loc, confidence: 0.7, message: `@keyframes ${k.name} is never referenced by an animation.`, details: { category: 'unused-css' } });
      }
    }
  }

  // JS references to ids that do not exist in any HTML file.
  if (hasHtml) {
    for (const [id, locs] of jsRefIds) {
      if (htmlIds.has(id)) continue;
      const created = strings.some((s) => s.includes(`id="${id}"`) || s.includes(`id='${id}'`) || s.includes(`id=${id}`));
      if (created) continue;
      for (const l of locs.slice(0, 3)) {
        suggestions.push({ file: l.file, kind: 'cross-reference', loc: { line: l.line, column: 1 }, confidence: 0.6, message: `Script looks up element id "${id}", which is not present in any HTML file.` });
      }
    }
  }

  const ids: CrossRefModel['ids'] = [...new Set([...htmlIds, ...cssById.keys(), ...jsRefIds.keys()])].sort().map((id) => ({
    id,
    html: htmls.flatMap((h) => h.elements.filter((e) => e.id === id).map((e) => ({ file: h.file, line: e.loc.line }))),
    css: cssById.get(id) ?? [],
    js: jsRefIds.get(id) ?? [],
    events: events.filter((e) => e.target === `#${id}`).map((e) => ({ event: e.event, handler: e.handler, file: e.file, line: e.line })),
  }));
  const classes: CrossRefModel['classes'] = [...new Set([...htmlClasses.keys(), ...cssByClass.keys(), ...jsRefClasses.keys()])].sort().map((name) => ({
    name,
    html: htmlClasses.get(name) ?? 0,
    css: cssByClass.get(name) ?? [],
    js: jsRefClasses.get(name) ?? [],
  }));

  return { ids, classes, events, protectedNames: [...protectedNames].sort(), suggestions };
}
