import { $, initPicker, initUi, type PickedFiles } from '../ui/common.js';
import type { WorkerMessage, WorkerRequest, WorkerResult } from './worker.js';

const ui = initUi();
const go = $<HTMLButtonElement>('go');
let picked: PickedFiles | null = null;
let last: WorkerResult | null = null;
let reportUrl = '';
let zipUrl = '';

initPicker(ui, (p) => {
  picked = p;
  $('picked').textContent = p.label;
  go.disabled = false;
  ui.say('');
});

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let jobId = 0;
worker.onmessage = (ev: MessageEvent<WorkerMessage>) => {
  const m = ev.data;
  if (m.id !== jobId) return;
  if (m.type === 'log') return ui.say(ui.t('refiningWeb'));
  go.disabled = false;
  if (m.type === 'error') return ui.say(m.message, true);
  const done = m as WorkerResult;
  last = done;
  URL.revokeObjectURL(reportUrl);
  URL.revokeObjectURL(zipUrl);
  reportUrl = URL.createObjectURL(new Blob([done.report], { type: 'text/html' }));
  zipUrl = URL.createObjectURL(new Blob([done.zip], { type: 'application/zip' }));
  $('sFiles').textContent = String(done.stats.files);
  $('sChanged').textContent = String(done.stats.changed);
  $('sWarn').textContent = String(done.stats.warnings);
  $<HTMLAnchorElement>('report').href = reportUrl;
  const zip = $<HTMLAnchorElement>('zip');
  zip.href = zipUrl;
  zip.download = `${picked?.name ?? 'project'}-refined.zip`;
  $('result').style.display = 'block';
  ui.say(done.aiNote);
};

go.addEventListener('click', () => {
  if (!picked) return;
  go.disabled = true;
  $('result').style.display = 'none';
  ui.say(ui.t('refiningWeb'));
  const mode = (document.querySelector('input[name=mode]:checked') as HTMLInputElement).value;
  const ai = ui.ai();
  const req: WorkerRequest = {
    id: ++jobId,
    name: picked.name,
    zip: picked.zip?.slice(0),
    entries: picked.entries?.map((e) => ({ path: e.path, data: e.data.slice(0) })),
    options: {
      mode,
      renameVariables: true,
      removeUnused: $<HTMLInputElement>('removeUnused').checked,
      language: ui.lang,
      ai: ai.enabled ? { provider: ai.provider, model: ai.model, baseUrl: ai.baseUrl, key: ai.key } : undefined,
    },
  };
  const transfer: Transferable[] = [];
  if (req.zip) transfer.push(req.zip);
  for (const e of req.entries ?? []) transfer.push(e.data);
  worker.postMessage(req, transfer);
});

const saveBtn = $<HTMLButtonElement>('save');
if (!('showDirectoryPicker' in window)) saveBtn.style.display = 'none';
saveBtn.addEventListener('click', async () => {
  if (!last) return;
  try {
    const root = await (window as unknown as { showDirectoryPicker(): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker();
    for (const f of last.files) {
      const parts = f.path.split('/');
      let dir = root;
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
      const w = await (await dir.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
      await w.write(f.data);
      await w.close();
    }
    ui.say(ui.t('saved', { n: last.files.length }));
  } catch (e) {
    if ((e as Error).name !== 'AbortError') ui.say((e as Error).message, true);
  }
});
