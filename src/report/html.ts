import { escapeHtml as e } from '../core/text.js';
import type { FileDiff } from '../core/diff.js';
import type { RefineResult } from '../pipeline.js';
import { describeConvention } from '../naming/convention.js';
import type { NameCandidate, Suggestion } from '../core/types.js';
import { resolveLanguage, type Lang } from '../i18n/lang.js';
import { translateMessage } from '../i18n/ja.js';

const pct = (n: number | undefined) => (n === undefined ? '' : `${Math.round(n * 100)}%`);

function confBar(n: number | undefined): string {
  if (n === undefined) return '';
  const cls = n >= 0.95 ? 'hi' : n >= 0.8 ? 'mid' : 'lo';
  return `<span class="conf ${cls}" title="confidence"><i style="width:${Math.round(n * 100)}%"></i></span> ${pct(n)}`;
}

function diffHtml(d: FileDiff): string {
  if (!d.hunks.length) return '<p class="muted">No textual diff available.</p>';
  const rows: string[] = [];
  for (const h of d.hunks) {
    rows.push(`<div class="hunk">@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@</div>`);
    for (const op of h.ops) rows.push(`<div class="${op.type}">${op.type === 'add' ? '+' : op.type === 'del' ? '-' : ' '}${e(op.line)}</div>`);
  }
  return `<div class="diff">${rows.join('')}</div>`;
}

function candidatesTable(c: NameCandidate[] | undefined, L: (s: string) => string): string {
  if (!c?.length) return '';
  return `<table class="cands"><tr><th>${L('candidate')}</th><th>${L('score')}</th><th>${L('evidence')}</th></tr>${c
    .map((x) => `<tr class="${x.usable ? '' : 'rej'}"><td><code>${e(x.name)}</code>${x.usable ? '' : ` <small>(${e(L(x.rejectedReason ?? 'unusable'))})</small>`}</td><td>${confBar(x.confidence)}</td><td><small>${x.evidence.map((v) => e(L(v))).join('<br>')}</small></td></tr>`)
    .join('')}</table>`;
}

function suggestionList(items: Suggestion[], empty: string, L: (s: string) => string): string {
  if (!items.length) return `<p class="muted">${e(L(empty))}</p>`;
  return `<ul class="list">${items
    .map((s) => `<li><code>${e(s.file)}${s.loc ? ':' + s.loc.line : ''}</code> ${e(L(s.message))} ${confBar(s.confidence)}</li>`)
    .join('')}</ul>`;
}

const statusBadge = (st: string, L: (s: string) => string) => `<span class="badge ${st === 'passed' ? 'ok' : st === 'failed' || st === 'rolled-back' ? 'bad' : 'muted'}">${e(L(st))}</span>`;

export function renderReportHtml(r: RefineResult, langOverride?: Lang): string {
  const lang: Lang = langOverride ?? resolveLanguage(r.config.language);
  const L = (s: string) => translateMessage(s, lang);
  const candidatesHtml = (c: NameCandidate[] | undefined) => candidatesTable(c, L);
  const sugList = (items: Suggestion[], empty: string) => suggestionList(items, empty, L);
  const s = r.stats;
  const renames = r.suggestions.filter((x) => x.kind === 'rename');
  const applied = renames.filter((x) => x.details?.applied === true);
  const pending = renames.filter((x) => x.details?.applied === false);
  const dead = r.suggestions.filter((x) => x.kind === 'dead-code');
  const dup = r.suggestions.filter((x) => x.kind === 'duplicate');
  const cx = r.suggestions.filter((x) => x.kind === 'complexity');
  const xref = r.suggestions.filter((x) => x.kind === 'cross-reference');
  const byFile = new Map<string, typeof r.changes>();
  for (const c of r.changes) {
    if (!byFile.has(c.file)) byFile.set(c.file, []);
    byFile.get(c.file)!.push(c);
  }
  const diffByPath = new Map(r.diffs.map((d) => [d.path, d]));
  const fnName = new Map(r.analysis.functions.map((f) => [f.id, f.name]));

  const callRoots = r.analysis.functions.filter((f) => f.calls.length && !r.analysis.callGraph.some((c) => c.callee === f.id));
  const callTrees = callRoots.slice(0, 12).map((f) => {
    const lines: string[] = [f.name];
    const walk = (id: string, prefix: string, depth: number, seen: Set<string>) => {
      const kids = [...new Set(r.analysis.callGraph.filter((c) => c.caller === id).map((c) => c.callee))].filter((k) => fnName.has(k));
      kids.forEach((k, i) => {
        const last = i === kids.length - 1;
        lines.push(`${prefix}${last ? '└─ ' : '├─ '}${fnName.get(k)}`);
        if (depth > 1 && !seen.has(k)) walk(k, prefix + (last ? '   ' : '│  '), depth - 1, new Set(seen).add(k));
      });
    };
    walk(f.id, '', 4, new Set([f.id]));
    return lines.join('\n');
  });

  const xr = r.analysis.crossRef;
  const css = `
:root{--bg:#fff;--fg:#1c1e21;--muted:#6b7280;--card:#f7f8fa;--line:#e3e6ea;--accent:#2457d6;--ok:#16794a;--warn:#a15c00;--bad:#b42318;--add:#e6f6ec;--del:#fdecec}
@media (prefers-color-scheme:dark){:root{--bg:#14161a;--fg:#e6e8eb;--muted:#9aa3ad;--card:#1d2026;--line:#2c313a;--accent:#7aa2ff;--ok:#4cc38a;--warn:#e0a040;--bad:#ff7b72;--add:#12301f;--del:#3a1a1a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1040px;margin:0 auto;padding:24px 16px 80px}h1{font-size:26px;margin:0 0 4px}h2{font-size:19px;margin:36px 0 10px;border-bottom:1px solid var(--line);padding-bottom:6px}
.muted{color:var(--muted)}code,pre{font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}code{background:var(--card);padding:1px 5px;border-radius:4px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:16px 0}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.card b{display:block;font-size:26px;line-height:1.1}.card span{color:var(--muted);font-size:13px}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600}
details{background:var(--card);border:1px solid var(--line);border-radius:8px;margin:8px 0;padding:6px 12px}summary{cursor:pointer;font-weight:600;padding:4px 0}
.diff{font:12.5px/1.45 ui-monospace,Menlo,monospace;overflow:auto;border:1px solid var(--line);border-radius:6px;margin:8px 0;max-height:420px}.diff div{white-space:pre;padding:0 8px}.diff .add{background:var(--add)}.diff .del{background:var(--del)}.diff .hunk{color:var(--muted);background:var(--card)}
.conf{display:inline-block;width:54px;height:7px;background:var(--line);border-radius:4px;vertical-align:middle;overflow:hidden}.conf i{display:block;height:100%}.conf.hi i{background:var(--ok)}.conf.mid i{background:var(--accent)}.conf.lo i{background:var(--warn)}
.list{padding-left:20px}.list li{margin:3px 0}.badge{font-size:12px;border-radius:10px;padding:1px 8px;background:var(--card);border:1px solid var(--line)}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
.cands .rej{opacity:.55}.tree{white-space:pre;overflow:auto;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
@media (max-width:600px){main{padding:16px 12px}.cards{grid-template-columns:repeat(2,1fr)}}`;

  const T = (en: string, ja: string) => (lang === 'ja' ? ja : en);
  const msg = (m: string) => e(L(m));
  const th = (k: string) => `<th>${e(L(k))}</th>`;
  const exampleCount = (n: number, one: string, many: string) => (lang === 'ja' ? `${n} 件` : `${n} ${n === 1 ? one : many}`);
  const conv = describeConvention(r.analysis.convention).map((x) => e(lang === 'ja' ? x.replace('casing:', '表記:').replace('collections:', 'コレクション:').replace('booleans:', '真偽値:').replace('no clear rule', '明確な規則なし').replace('no clear prefix', '明確な接頭辞なし').replace('plural noun', '複数形の名詞') : x)).join(' · ');

  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(L('CodeRefiner report'))} – ${e(r.project.name)}</title><style>${css}</style></head><body><main>
<h1>${e(L('CodeRefiner report'))}</h1>
<p class="muted">${e(r.project.name)} · ${T('mode', 'モード')} <b>${e(r.config.mode)}</b> · ${T(`AI advisor ${r.aiUsed ? 'used' : 'not used'}`, `AI Advisor ${r.aiUsed ? '使用' : '未使用'}`)} · ${T('Analysis refers to the <i>original</i> files; line numbers are original lines.', '解析結果は<i>元の</i>ファイルが対象で、行番号は元の行番号です。')}</p>

<div class="cards">
 <div class="card"><b>${s.processedFiles}</b><span>${T(`files processed (of ${s.totalFiles})`, `処理したファイル (全 ${s.totalFiles} 件中)`)}</span></div>
 <div class="card"><b>${s.changedFiles}</b><span>${e(L('files changed'))}</span></div>
 <div class="card"><b>${s.renames}</b><span>${e(L('names changed'))}</span></div>
 <div class="card"><b>${s.refactorings}</b><span>${e(L('refactorings'))}</span></div>
 <div class="card"><b class="${s.warnings ? 'warn' : ''}">${s.warnings}</b><span>${e(L('warnings'))}</span></div>
 <div class="card"><b>+${s.linesAdded} / −${s.linesRemoved}</b><span>${e(L('lines'))}</span></div>
</div>

<h2>${e(L('Project'))}</h2>
<table><tr>${th('runtime')}<td>${e(r.metadata.runtime)}</td></tr>
<tr>${th('languages')}<td>${e(r.metadata.languages.join(', ') || '–')}</td></tr>
<tr>${th('frameworks')}<td>${e(r.metadata.frameworks.join(', ') || '–')}</td></tr>
<tr>${th('build tools')}<td>${e(r.metadata.buildTools.join(', ') || '–')}</td></tr>
<tr>${th('entry points')}<td>${r.metadata.entryPoints.map((x) => `<code>${e(x)}</code>`).join(' ') || '–'}</td></tr>
${r.metadata.unsupportedLanguages.length ? `<tr>${th('no Language Pack')}<td>${e(r.metadata.unsupportedLanguages.join(', '))} ${T('(copied unchanged)', '(そのままコピー)')}</td></tr>` : ''}</table>

<h2>${e(L('Validation'))}</h2>
<table>${r.validation.checks.map((c) => `<tr><td>${e(L(c.name))}${c.file ? ` <code>${e(c.file)}</code>` : ''}</td><td>${statusBadge(c.status, L)}</td><td class="muted">${msg(c.detail ?? '')}</td></tr>`).join('')}</table>
${r.validation.rolledBack.length ? `<p class="bad">${T('Rolled back to the original', '元に戻したファイル')}: ${r.validation.rolledBack.map((p) => `<code>${e(p)}</code>`).join(', ')}</p>` : ''}

<h2>${T('Warnings', '警告')} (${r.warnings.length})</h2>
${r.warnings.length ? `<ul class="list">${r.warnings.map((w) => `<li><span class="badge">${e(w.code)}</span> ${w.file ? `<code>${e(w.file)}</code> ` : ''}${msg(w.message)}</li>`).join('')}</ul>` : `<p class="muted">${e(L('None.'))}</p>`}

<h2>${T('Changes by file', 'ファイルごとの変更')} (${r.changes.length})</h2>
${[...byFile.entries()].map(([file, cs]) => `<details><summary><code>${e(file)}</code> <span class="muted">– ${exampleCount(cs.length, 'change', 'changes')}</span></summary>
<ul class="list">${cs.map((c) => `<li><span class="badge">${e(L(c.level))}</span> <b>${e(c.ruleId)}</b>: ${msg(c.description)}${c.loc ? ` <small class="muted">(${T('line', '行')} ${c.loc.line})</small>` : ''} ${c.kind === 'rename' ? confBar(c.confidence) : ''}</li>`).join('')}</ul>
${diffByPath.has(file) ? diffHtml(diffByPath.get(file)!) : ''}</details>`).join('') || `<p class="muted">${e(L('No files were changed.'))}</p>`}

<h2>${e(L('Naming'))}</h2>
<p class="muted">${T('Project convention', 'プロジェクトの命名規則')}: ${conv}. ${T('Confidence thresholds', '確信度のしきい値')}: ${T('auto', '自動適用')} ≥ ${pct(r.config.thresholds.autoApply)}, ${T('recommended', '推奨')} ≥ ${pct(r.config.thresholds.recommend)}, ${T('candidate', '候補表示')} ≥ ${pct(r.config.thresholds.suggest)}.</p>
<h3>${T('Applied', '適用した変更')} (${applied.length})</h3>
${applied.length ? applied.map((x) => `<details><summary><code>${e(x.file)}:${x.loc?.line ?? ''}</code> ${msg(x.message)} ${confBar(x.confidence)}</summary>${candidatesHtml(x.candidates)}</details>`).join('') : `<p class="muted">${e(L('No names were changed.'))}</p>`}
<h3>${T('Candidates – not applied', '候補 (未適用)')} (${pending.length})</h3>
${pending.length ? pending.map((x) => `<details><summary><code>${e(x.file)}:${x.loc?.line ?? ''}</code> ${msg(x.message)} ${confBar(x.confidence)}</summary>${candidatesHtml(x.candidates)}</details>`).join('') : `<p class="muted">${e(L('No candidates.'))}</p>`}
${r.analysis.abbreviations.length ? `<h3>${e(L('Abbreviations seen in the project'))}</h3><p>${r.analysis.abbreviations.slice(0, 20).map((a) => `<code>${e(a.abbreviation)}</code> → <code>${e(a.expansion)}</code>`).join(' · ')}</p>` : ''}
${Object.keys(r.analysis.variantGroups).length ? `<h3>${e(L('Spelling variants'))}</h3><ul class="list">${Object.entries(r.analysis.variantGroups).slice(0, 15).map(([k, v]) => `<li><b>${e(k)}</b>: ${v.map((x) => `<code>${e(x)}</code>`).join(' ')}</li>`).join('')}</ul>` : ''}

<h2>${T('Removal candidates', '削除候補')} (${dead.length})</h2>
<p class="muted">${T('Nothing is deleted unless <code>removeUnused</code> is on. These are reports only.', '<code>removeUnused</code> を有効にしない限り何も削除しません。ここは報告のみです。')}</p>
${sugList(dead, 'No dead code found.')}

<h2>${T('Duplicates', '重複')} (${dup.length})</h2>
${sugList(dup, 'No duplicates found.')}

<h2>${T('Complexity', '複雑度')} (${cx.length})</h2>
${sugList(cx, 'Nothing exceeds the configured limits.')}

<h2>${e(L('HTML ↔ CSS ↔ JavaScript'))}</h2>
${sugList(xref, 'No cross-reference problems found.')}
${xr.ids.length ? `<details><summary>${T('Elements by id', 'id ごとの要素')} (${xr.ids.length})</summary><table><tr><th>id</th><th>HTML</th><th>CSS</th><th>JS</th>${th('events')}</tr>${xr.ids.map((i) => `<tr><td><code>#${e(i.id)}</code></td><td>${i.html.length}</td><td>${i.css.map((c) => `<code>${e(c.selector)}</code>`).join(' ')}</td><td>${i.js.length}</td><td>${i.events.map((ev) => `${e(ev.event)}${ev.handler ? ' → <code>' + e(ev.handler) + '</code>' : ''}`).join('<br>')}</td></tr>`).join('')}</table></details>` : ''}
${xr.events.length ? `<details><summary>${T('Event wiring', 'イベントの結び付き')} (${xr.events.length})</summary><ul class="list">${xr.events.map((ev) => `<li>${ev.target ? `<code>${e(ev.target)}</code> ` : ''}${e(ev.event)}${ev.handler ? ` → <code>${e(ev.handler)}</code>` : ''} <small class="muted">${e(ev.source)} · ${e(ev.file)}:${ev.line}</small></li>`).join('')}</ul></details>` : ''}

<h2>${e(L('Structure'))}</h2>
${r.analysis.modules.length ? `<details><summary>${T('Modules', 'モジュール')} (${r.analysis.modules.length})</summary><table><tr>${th('file')}${th('imports')}${th('exports')}</tr>${r.analysis.modules.map((m) => `<tr><td><code>${e(m.file)}</code></td><td>${m.imports.map((i) => `<code>${e(i.source)}</code>`).join(' ')}</td><td>${m.exports.map((x) => `<code>${e(x)}</code>`).join(' ')}</td></tr>`).join('')}</table></details>` : ''}
${r.analysis.dataFlow.length ? `<details><summary>${T('Data flow', 'データフロー')} (${r.analysis.dataFlow.length})</summary><p class="muted">${e(L('source → transform → result'))}</p><ul class="list">${r.analysis.dataFlow.slice(0, 150).map((d) => `<li><code>${e(d.from.split('::')[1]?.split('@')[0] ?? d.from)}</code> —${e(d.via)}→ <code>${e(d.to.split('::')[1]?.split('@')[0] ?? d.to)}</code> <small class="muted">${e(d.file)}</small></li>`).join('')}</ul></details>` : ''}
${r.analysis.cycles.length ? `<p class="warn">${T('Circular dependencies', '循環依存')}: ${r.analysis.cycles.map((c) => c.map((x) => `<code>${e(x)}</code>`).join(' ↔ ')).join('; ')}</p>` : `<p class="muted">${e(L('No circular dependencies.'))}</p>`}
<details><summary>${T('Dependencies', '依存関係')} (${r.analysis.dependencies.length})</summary><ul class="list">${r.analysis.dependencies.map((d) => `<li><code>${e(d.from)}</code> → <code>${e(d.to)}</code> <small class="muted">${e(d.kind)}</small></li>`).join('')}</ul></details>
${callTrees.length ? `<details><summary>${e(L('Call graph'))}</summary>${callTrees.map((t) => `<div class="tree">${e(t)}</div>`).join('')}</details>` : ''}
<details><summary>${e(L('Project vocabulary'))}</summary><p>${r.analysis.vocabulary.slice(0, 40).map((v) => `<code>${e(v.word)}</code> ×${v.count}`).join(' · ')}</p></details>

<h2>${e(L('Files'))}</h2>
<details><summary>${T('All files', 'すべてのファイル')} (${r.files.length})</summary><table><tr>${th('path')}${th('status')}${th('note')}</tr>${r.files.map((f) => `<tr><td><code>${e(f.path)}</code></td><td>${e(L(f.status))}</td><td class="muted">${msg(f.note ?? '')}</td></tr>`).join('')}</table></details>
</main></body></html>`;
}
