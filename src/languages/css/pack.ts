import postcss from 'postcss';
import type { Root, Rule as PostcssRule, Declaration, AtRule, ChildNode, Container } from 'postcss';
import selectorParser from 'postcss-selector-parser';
import { createHash } from 'node:crypto';
import { hitToChange, rulesFor, type Rule, type RuleHit } from '../../core/rule-engine.js';
import type { Loc } from '../../core/types.js';
import type { CssFileModel, CssSelectorInfo } from '../../semantic/model.js';
import type { FormatterAdapter, LanguagePack, RefineInput, RefineOutput } from '../types.js';

const loc = (n: { source?: { start?: { line: number; column: number } } }): Loc => ({ line: n.source?.start?.line ?? 0, column: n.source?.start?.column ?? 0 });
const snippet = (n: ChildNode, max = 90) => n.toString().replace(/\s+/g, ' ').trim().slice(0, max);

// ---- Rules ---------------------------------------------------------------------------------------

type CssRule = Rule<Root, { source: string }>;

const dedupeDeclarations: CssRule = {
  id: 'css-dedupe-declarations',
  description: 'Removes an earlier declaration that is repeated verbatim later in the same rule',
  level: 'safe',
  apply(root) {
    const hits: RuleHit[] = [];
    root.walkRules((rule) => {
      const decls = rule.nodes?.filter((n): n is Declaration => n.type === 'decl') ?? [];
      for (let i = 0; i < decls.length; i++) {
        const d = decls[i];
        const later = decls.slice(i + 1).find((o) => o.prop.toLowerCase() === d.prop.toLowerCase() && o.value === d.value && !!o.important === !!d.important);
        if (later && !d.prop.startsWith('--')) {
          hits.push({ description: `Removed duplicate declaration "${d.prop}: ${d.value}" in ${rule.selector}`, loc: loc(d), before: snippet(d) });
          d.remove();
        }
      }
    });
    return hits;
  },
};

const mergeAdjacentRules: CssRule = {
  id: 'css-merge-adjacent-rules',
  description: 'Merges directly adjacent rules that have the identical selector',
  level: 'safe',
  apply(root) {
    const hits: RuleHit[] = [];
    const visit = (container: Container): void => {
      const kids = container.nodes ?? [];
      for (let i = 0; i < kids.length - 1; i++) {
        const a = kids[i];
        const b = kids[i + 1];
        if (a.type === 'rule' && b.type === 'rule' && normSel(a.selector) === normSel(b.selector) && !a.raws.before?.includes('/*')) {
          hits.push({ description: `Merged adjacent rules for ${a.selector}`, loc: loc(b), before: snippet(b) });
          b.each((child) => {
            a.append(child.clone());
          });
          b.remove();
          i--;
        }
      }
      for (const k of container.nodes ?? []) {
        if (k.type === 'atrule' || k.type === 'rule') visit(k as Container);
      }
    };
    visit(root);
    return hits;
  },
};

const removeEmptyRules: CssRule = {
  id: 'css-remove-empty-rules',
  description: 'Removes rules and at-rules without any content (CSSOM rule indexes may shift)',
  level: 'cautious',
  apply(root) {
    const hits: RuleHit[] = [];
    let found = true;
    while (found) {
      found = false;
      root.walk((n) => {
        const c = n as Container;
        const container = n.type === 'rule' || (n.type === 'atrule' && ['media', 'supports', 'layer'].includes((n as AtRule).name));
        if (container && c.nodes && c.nodes.length === 0) {
          hits.push({ description: `Removed empty ${n.type === 'rule' ? 'rule ' + (n as PostcssRule).selector : '@' + (n as AtRule).name}`, loc: loc(n), before: snippet(n) });
          n.remove();
          found = true;
        }
      });
    }
    return hits;
  },
};

export const CSS_RULES: CssRule[] = [dedupeDeclarations, mergeAdjacentRules, removeEmptyRules];

function normSel(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/\s*([>+~,])\s*/g, '$1').trim();
}

// ---- Analysis ------------------------------------------------------------------------------------

function analyzeSelector(sel: string): Omit<CssSelectorInfo, 'selector' | 'loc'> {
  const out = { classes: [] as string[], ids: [] as string[], dataAttrs: [] as string[], tags: [] as string[], opaque: false };
  try {
    selectorParser((root) => {
      root.walk((n) => {
        if (n.type === 'class') out.classes.push(n.value);
        else if (n.type === 'id') out.ids.push(n.value);
        else if (n.type === 'attribute') {
          if (n.attribute.startsWith('data-')) out.dataAttrs.push(n.attribute);
          else if (n.attribute === 'class' || n.attribute === 'id') out.opaque = true;
        } else if (n.type === 'tag') out.tags.push(n.value.toLowerCase());
        else if (n.type === 'pseudo' && /^:(is|where|not|has|matches|host|host-context|global|local)$/.test(n.value) && n.nodes.length === 0) out.opaque = true;
      });
    }).processSync(sel);
  } catch {
    out.opaque = true;
  }
  return out;
}

export function analyzeCss(source: string, file: string): CssFileModel | null {
  let root: Root;
  try {
    root = postcss.parse(source, { from: file });
  } catch {
    return null;
  }
  const model: CssFileModel = { file, selectors: [], customPropsDeclared: [], customPropsUsed: [], keyframes: [], animationNamesUsed: [], imports: [], blockHashes: [] };
  root.walk((n) => {
    if (n.type === 'rule') {
      if (n.parent?.type === 'atrule' && /keyframes$/i.test((n.parent as AtRule).name)) return;
      for (const s of n.selectors) model.selectors.push({ selector: s.trim(), loc: loc(n), ...analyzeSelector(s) });
      const decls = (n.nodes ?? []).filter((c): c is Declaration => c.type === 'decl');
      if (decls.length >= 2) {
        const key = decls.map((d) => `${d.prop.toLowerCase()}:${d.value.replace(/\s+/g, ' ')}${d.important ? '!' : ''}`).sort().join(';');
        model.blockHashes.push({ hash: createHash('sha1').update(key).digest('hex').slice(0, 16), selector: n.selector.replace(/\s+/g, ' '), loc: loc(n), decls: decls.length });
      }
    } else if (n.type === 'decl') {
      if (n.prop.startsWith('--')) model.customPropsDeclared.push({ name: n.prop, loc: loc(n) });
      for (const m of n.value.matchAll(/url\(\s*['"]?([^'")\s]+)/g)) if (!/^(https?:|\/\/|data:|#)/i.test(m[1])) model.imports.push(m[1].split(/[?#]/)[0]);
      for (const m of n.value.matchAll(/var\(\s*(--[\w-]+)/g)) model.customPropsUsed.push(m[1]);
      if (/^(-\w+-)?animation(-name)?$/i.test(n.prop)) for (const tok of n.value.split(/[\s,]+/)) if (/^[A-Za-z_][\w-]*$/.test(tok)) model.animationNamesUsed.push(tok);
    } else if (n.type === 'atrule') {
      if (/keyframes$/i.test(n.name)) model.keyframes.push({ name: n.params.trim(), loc: loc(n) });
      if (n.name === 'import') model.imports.push(n.params.replace(/^url\(|\)$|["']/g, '').split(/\s/)[0]);
    }
  });
  return model;
}

// ---- Equivalence of formatting ---------------------------------------------------------------------

function normalizeValue(v: string): string {
  return v
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([,:;>+~()])\s*/g, '$1')
    .replace(/["']/g, '"')
    .replace(/(?<![\w.])0*(\d*\.\d+)/g, (_m, d: string) => String(parseFloat(d)))
    .replace(/(\d)\.0+(?!\d)/g, '$1')
    .replace(/(\.\d*?)0+(?![\d])/g, '$1')
    .replace(/\b0+(\d)/g, '$1')
    .replace(/;$/, '')
    .toLowerCase()
    .trim();
}

function signature(root: Root): string[] {
  const out: string[] = [];
  root.walk((n) => {
    if (n.type === 'rule') out.push(`rule ${normalizeValue(n.selector)}`);
    else if (n.type === 'decl') out.push(`decl ${n.prop.toLowerCase()} ${normalizeValue(n.value)}${n.important ? '!' : ''}`);
    else if (n.type === 'atrule') out.push(`at ${n.name.toLowerCase()} ${normalizeValue(n.params)}`);
  });
  return out;
}

export function cssEquivalent(a: string, b: string): boolean | undefined {
  try {
    return JSON.stringify(signature(postcss.parse(a))) === JSON.stringify(signature(postcss.parse(b)));
  } catch {
    return undefined;
  }
}

// ---- Pack ----------------------------------------------------------------------------------------

export function cssPack(formatter: FormatterAdapter): LanguagePack {
  return {
    id: 'css',
    displayName: 'CSS',
    extensions: ['.css'],
    formatter,
    rules: CSS_RULES.map((r) => ({ id: r.id, description: r.description, level: r.level })),
    checkSyntax(source, file) {
      try {
        postcss.parse(source, { from: file });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    analyze({ file, source }) {
      const css = analyzeCss(source, file);
      return css ? { css } : {};
    },
    async refine(input: RefineInput): Promise<RefineOutput> {
      const { file, config, embedded } = input;
      const out: RefineOutput = { code: input.source, changes: [], suggestions: [], warnings: [] };
      let current = input.source;
      try {
        postcss.parse(current, { from: file });
      } catch (e) {
        out.warnings.push({ code: 'syntax-error', file, message: `Skipped: could not parse (${(e as Error).message})` });
        return out;
      }
      for (const rule of rulesFor(CSS_RULES, config.mode)) {
        const root = postcss.parse(current, { from: file });
        const hits = rule.apply(root, { source: current });
        if (!hits.length) continue;
        const next = root.toString();
        try {
          postcss.parse(next, { from: file });
        } catch (e) {
          out.warnings.push({ code: 'rule-rolled-back', file, message: `${rule.id}: result did not parse again; reverted` });
          continue;
        }
        current = next;
        for (const h of hits) out.changes.push(hitToChange(h, rule, file, 'style'));
      }
      if (!embedded) {
        try {
          const formatted = await formatter.format(current, file);
          if (cssEquivalent(current, formatted) === true) current = formatted;
          else out.warnings.push({ code: 'format-skipped', file, message: 'Formatter output was not provably equivalent; left unformatted' });
        } catch (e) {
          out.warnings.push({ code: 'format-failed', file, message: (e as Error).message });
        }
      }
      out.code = current;
      if (current !== input.source) out.changes.push({ file, kind: 'format', ruleId: 'format', level: 'safe', description: `Formatted (${formatter.id})`, confidence: 1 });
      return out;
    },
    isEquivalent: (a, b) => cssEquivalent(a, b),
  };
}
