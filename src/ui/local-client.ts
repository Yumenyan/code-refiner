import { $, initPicker, initUi, zipStore, type PickedFiles } from './common.js';

const ui = initUi();
let picked: { name: string; blob: Blob } | null = null;
let last: { id: string; refinedDir: string } | null = null;
const go = $<HTMLButtonElement>('go');

initPicker(ui, (p: PickedFiles) => {
  const blob = p.zip ? new Blob([p.zip], { type: 'application/zip' }) : zipStore((p.entries ?? []).map((e) => ({ name: e.path, data: new Uint8Array(e.data) })));
  picked = { name: p.name, blob };
  $('picked').textContent = p.label;
  go.disabled = false;
  ui.say('');
});

go.addEventListener('click', async () => {
  if (!picked) return;
  go.disabled = true;
  $('result').style.display = 'none';
  ui.say(ui.t('refining'));
  const mode = (document.querySelector('input[name=mode]:checked') as HTMLInputElement).value;
  const ai = ui.ai();
  const q = new URLSearchParams({ mode, name: picked.name, lang: ui.lang, removeUnused: $<HTMLInputElement>('removeUnused').checked ? '1' : '0' });
  if (ai.enabled) {
    q.set('ai', '1');
    q.set('provider', ai.provider);
    if (ai.model) q.set('model', ai.model);
    if (ai.baseUrl) q.set('baseUrl', ai.baseUrl);
  }
  const headers: Record<string, string> = { 'X-CodeRefiner': '1', 'Content-Type': 'application/zip' };
  if (ai.enabled && ai.key) headers['X-AI-Key'] = ai.key; // header, never the URL
  try {
    const res = await fetch(`/api/refine?${q}`, { method: 'POST', headers, body: picked.blob });
    const j = (await res.json()) as { id: string; files: number; changed: number; warnings: number; refinedDir: string; aiNote?: string; error?: string };
    if (!res.ok) throw new Error(j.error ?? 'Failed');
    last = j;
    $('sFiles').textContent = String(j.files);
    $('sChanged').textContent = String(j.changed);
    $('sWarn').textContent = String(j.warnings);
    $<HTMLAnchorElement>('report').href = `/out/${j.id}/report.html`;
    $<HTMLAnchorElement>('zip').href = `/out/${j.id}/refined-project.zip`;
    $('where').textContent = j.refinedDir;
    $('result').style.display = 'block';
    ui.say(j.aiNote ?? '');
  } catch (e) {
    ui.say((e as Error).message, true);
  } finally {
    go.disabled = false;
  }
});

$('open').addEventListener('click', async () => {
  if (!last) return;
  const r = await fetch(`/api/open?id=${last.id}`, { method: 'POST', headers: { 'X-CodeRefiner': '1' } });
  if (!r.ok) ui.say(ui.t('openFailed') + last.refinedDir, true);
});
