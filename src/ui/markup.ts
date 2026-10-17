/** Shared page markup for the local UI and the static web version. */
export type Variant = 'local' | 'web';

const CSS = `
:root{--bg:#fff;--fg:#1c1e21;--muted:#6b7280;--card:#f7f8fa;--line:#d9dde3;--accent:#2457d6;--accent-fg:#fff;--bad:#b42318;--ok:#16794a}
@media (prefers-color-scheme:dark){:root{--bg:#14161a;--fg:#e6e8eb;--muted:#9aa3ad;--card:#1d2026;--line:#333844;--accent:#6f98ff;--accent-fg:#0b1020;--bad:#ff7b72;--ok:#4cc38a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI","Hiragino Sans","Noto Sans JP",sans-serif;display:flex;justify-content:center}
main{width:100%;max-width:560px;padding:32px 16px 64px}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}h1{font-size:28px;margin:0;letter-spacing:-.01em}
#lang{font:inherit;font-size:14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);padding:5px 8px}
#drop{border:2px dashed var(--line);border-radius:14px;padding:44px 16px;text-align:center;background:var(--card);cursor:pointer;transition:border-color .15s,background .15s}
#drop.over{border-color:var(--accent)}#drop b{display:block;font-size:17px;margin-bottom:4px}#drop span{color:var(--muted);font-size:14px}
#picked{margin-top:10px;color:var(--muted);font-size:14px;min-height:21px;word-break:break-all}
fieldset{border:0;padding:0;margin:22px 0 0}legend{font-weight:600;margin-bottom:6px;padding:0}
label{display:flex;gap:8px;align-items:flex-start;padding:5px 0;cursor:pointer}label small{color:var(--muted);display:block}
button{font:inherit;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--fg);padding:10px 16px;cursor:pointer}
button.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent);font-weight:600;width:100%;margin-top:26px;padding:13px}
button:disabled{opacity:.5;cursor:default}#result{margin-top:30px;display:none}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;text-align:center}
.stat b{display:block;font-size:26px}.stat span{color:var(--muted);font-size:13px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.actions>*{flex:1 1 140px;text-align:center;text-decoration:none}
a.btn{font:inherit;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--fg);padding:10px 16px}
#msg{margin-top:14px;font-size:14px;color:var(--muted)}#msg.err{color:var(--bad)}#where{margin-top:12px;color:var(--muted);font-size:13px;word-break:break-all}
#aiBox{display:none;margin:4px 0 0 26px}#aiBox label{display:block;padding:6px 0 0;font-size:14px}#aiBox select,#aiBox input{font:inherit;width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);margin-top:4px}
#aiBox p{font-size:13px;color:var(--muted);margin:8px 0 0}
#adv{margin-top:22px;border:1px solid var(--line);border-radius:10px;background:var(--card);padding:4px 12px}#adv summary{cursor:pointer;font-weight:600;padding:8px 0}.advBox{padding:0 0 10px}.advBox label{display:block;padding:6px 0 0;font-size:14px}.advBox label.row{display:flex}.advBox select,.advBox input[type=number],.advBox input:not([type]),.advBox textarea{font:inherit;width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);margin-top:4px}.advBox textarea{font-family:ui-monospace,Menlo,monospace;font-size:13px}.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}footer{margin-top:36px;color:var(--muted);font-size:13px}`;

export function renderPageHtml(variant: Variant, scriptHtml: string): string {
  const web = variant === 'web';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeRefiner</title>
<meta name="description" content="Restructure machine-written code into human-maintainable projects.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='3' fill='%232457d6'/%3E%3Cpath d='M4 8l3 3 5-6' stroke='white' stroke-width='2' fill='none'/%3E%3C/svg%3E">
<style>${CSS}</style></head><body><main>
<div class="top"><h1>CodeRefiner</h1><select id="lang" aria-label="Language"><option value="en">English</option><option value="ja">日本語</option></select></div>
<noscript><p style="color:#b42318">JavaScript is required / JavaScript が必要です。</p></noscript>
<div id="drop" tabindex="0" role="button"><b data-i18n="dropTitle">Drop a ZIP or folder here</b><span><span data-i18n="dropSub">or click to choose a ZIP file · </span><a href="#" id="pickFolder" data-i18n="pickFolder">choose a folder</a></span></div>
<input type="file" id="fileInput" accept=".zip,application/zip" hidden>
<input type="file" id="folderInput" webkitdirectory multiple hidden>
<div id="picked"></div>
<fieldset><legend data-i18n="modeLegend">Mode</legend>
<label><input type="radio" name="mode" value="safe" checked><span><span data-i18n="safe">Safe</span><small data-i18n="safeHint"></small></span></label>
<label><input type="radio" name="mode" value="cautious"><span><span data-i18n="cautious">Cautious</span><small data-i18n="cautiousHint"></small></span></label>
<label><input type="radio" name="mode" value="aggressive"><span><span data-i18n="aggressive">Aggressive</span><small data-i18n="aggressiveHint"></small></span></label>
<label><input type="checkbox" id="removeUnused"><span><span data-i18n="removeUnused">Remove unused code</span><small data-i18n="removeUnusedHint"></small></span></label>
</fieldset>
<fieldset><legend data-i18n="aiLegend">AI</legend>
<label><input type="checkbox" id="ai"><span><span data-i18n="aiEnable">Enable AI Advisor</span><small data-i18n="${web ? 'aiHintWeb' : 'aiHintLocal'}"></small></span></label>
<div id="aiBox">
<label><span data-i18n="aiProvider">Provider</span><select id="aiProvider"><option value="anthropic" data-i18n="providerAnthropic"></option><option value="openai" data-i18n="providerOpenai"></option><option value="gemini" data-i18n="providerGemini"></option><option value="local" data-i18n="providerLocal"></option></select></label>
<label><span data-i18n="aiModel">Model</span><input id="aiModel" placeholder="claude-haiku-5-5" autocomplete="off"></label>
<label id="baseRow"><span data-i18n="aiBaseUrl">Base URL</span><input id="aiBase" placeholder="http://localhost:11434/v1" autocomplete="off"></label>
<label id="keyRow"><span data-i18n="aiKey">API key</span><input type="password" id="aiKey" autocomplete="off" placeholder="sk-…"></label>
<p id="localNote" data-i18n="aiLocalNote"></p>
</div></fieldset>
<details id="adv"><summary data-i18n="advanced">Advanced settings</summary>
<div class="advBox">
<label><span data-i18n="advTarget">Language level</span><select id="advTarget"><option value="" data-i18n="targetLatest">Latest</option><option value="es3">ES3</option><option value="es5">ES5</option><option value="rhino">Rhino (ES5, old engine)</option><option value="es2015">ES2015 (ES6)</option><option value="es2017">ES2017</option><option value="es2020">ES2020</option></select><small data-i18n="advTargetHint"></small></label>
<label><span data-i18n="advApply">Rename threshold</span><input id="advApply" type="number" min="0" max="1" step="0.01" placeholder="0.80"><small data-i18n="advApplyHint"></small></label>
<div class="grid3"><label><span data-i18n="advSuggest">suggest</span><input id="advSuggest" type="number" min="0" max="1" step="0.01" placeholder="0.50"></label>
<label><span data-i18n="advRecommend">recommend</span><input id="advRecommend" type="number" min="0" max="1" step="0.01" placeholder="0.80"></label>
<label><span data-i18n="advAuto">auto</span><input id="advAuto" type="number" min="0" max="1" step="0.01" placeholder="0.95"></label></div>
<label><span data-i18n="advAiApply">AI threshold</span><input id="advAiApply" type="number" min="0" max="2" step="0.01" placeholder="0.80"></label>
<label><span data-i18n="advLangMap">Extension map</span><input id="advLangMap" placeholder=".rhino=javascript, .gs=javascript" autocomplete="off"><small data-i18n="advLangMapHint"></small></label>
<label class="row"><input type="checkbox" id="advSniff"><span><span data-i18n="advSniff">Detect by content</span><small data-i18n="advSniffHint"></small></span></label>
<label><span data-i18n="advJson">Config JSON</span><textarea id="advJson" rows="4" spellcheck="false" placeholder='{"complexity":{"maxNesting":3}}'></textarea><small data-i18n="advJsonHint"></small></label>
</div></details>
<button class="primary" id="go" disabled data-i18n="refine">REFINE</button>
<div id="msg" role="status"></div>
<section id="result">
<div class="stats"><div class="stat"><b id="sFiles">0</b><span data-i18n="files">Files</span></div><div class="stat"><b id="sChanged">0</b><span data-i18n="changed">Changed</span></div><div class="stat"><b id="sWarn">0</b><span data-i18n="warnings">Warnings</span></div></div>
<div class="actions"><a class="btn" id="report" target="_blank" rel="noopener" data-i18n="viewReport">View Report</a>${web ? '<button id="save" data-i18n="saveFolder">Save to Folder</button>' : '<button id="open" data-i18n="openFolder">Open Refined Folder</button>'}<a class="btn" id="zip" download data-i18n="exportZip">Export ZIP</a></div>
<div id="where"></div>
</section>
${web ? '<footer data-i18n="footer"></footer>' : ''}
${scriptHtml}
</main></body></html>`;
}
