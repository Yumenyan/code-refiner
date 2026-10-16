import type { WorkerMessage, WorkerRequest, WorkerResult } from './worker.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const drop = $('drop');
const go = $<HTMLButtonElement>('go');
const msg = $('msg');
let picked: { name: string; label: string; zip?: ArrayBuffer; entries?: { path: string; data: ArrayBuffer }[] } | null = null;
let last: WorkerResult | null = null;
let reportUrl = '';
let zipUrl = '';

const say = (t: string, err = false) => {
  msg.textContent = t;
  msg.className = err ? 'err' : '';
};
const setPicked = (p: typeof picked) => {
  picked = p;
  $('picked').textContent = p?.label ?? '';
  go.disabled = !p;
  say('');
};

async function readEntry(entry: FileSystemEntry, prefix: string, out: { path: string; data: ArrayBuffer }[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((ok, fail) => (entry as FileSystemFileEntry).file(ok, fail));
    out.push({ path: prefix + entry.name, data: await file.arrayBuffer() });
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((ok, fail) => reader.readEntries(ok, fail));
      if (!batch.length) break;
      for (const e of batch) await readEntry(e, `${prefix}${entry.name}/`, out);
    }
  }
}

async function pickZip(f: File): Promise<void> {
  setPicked({ name: f.name.replace(/\.zip$/i, ''), label: `${f.name} (${Math.round(f.size / 1024)} KB)`, zip: await f.arrayBuffer() });
}

drop.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).id !== 'pickFolder') $<HTMLInputElement>('fileInput').click();
});
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    $<HTMLInputElement>('fileInput').click();
  }
});
$('pickFolder').addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  $<HTMLInputElement>('folderInput').click();
});
$<HTMLInputElement>('fileInput').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) void pickZip(f);
});
$<HTMLInputElement>('folderInput').addEventListener('change', async (e) => {
  const files = [...((e.target as HTMLInputElement).files ?? [])];
  if (!files.length) return;
  say('Reading folder…');
  const root = files[0].webkitRelativePath.split('/')[0] || 'project';
  const entries = await Promise.all(files.map(async (f) => ({ path: f.webkitRelativePath.split('/').slice(1).join('/') || f.name, data: await f.arrayBuffer() })));
  setPicked({ name: root, label: `${root}/ (${files.length} files)`, entries });
});
['dragenter', 'dragover'].forEach((n) => drop.addEventListener(n, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((n) => drop.addEventListener(n, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', async (e) => {
  const item = e.dataTransfer?.items[0];
  const entry = item?.webkitGetAsEntry?.();
  if (entry?.isDirectory) {
    say('Reading folder…');
    const out: { path: string; data: ArrayBuffer }[] = [];
    // read children directly so the folder name does not become part of every path
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((ok, fail) => reader.readEntries(ok, fail));
      if (!batch.length) break;
      for (const c of batch) await readEntry(c, '', out);
    }
    setPicked({ name: entry.name, label: `${entry.name}/ (${out.length} files)`, entries: out });
    return;
  }
  const f = e.dataTransfer?.files[0];
  if (f && /\.zip$/i.test(f.name)) await pickZip(f);
  else say('Please drop a .zip file or a folder.', true);
});

$<HTMLInputElement>('ai').addEventListener('change', (e) => {
  $('aiKeyRow').style.display = (e.target as HTMLInputElement).checked ? 'block' : 'none';
});

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let jobId = 0;
worker.onmessage = (ev: MessageEvent<WorkerMessage>) => {
  const m = ev.data;
  if (m.id !== jobId) return;
  if (m.type === 'log') return say(m.message);
  go.disabled = false;
  if (m.type === 'error') return say(m.message, true);
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
  say(done.aiNote);
};

go.addEventListener('click', () => {
  if (!picked) return;
  go.disabled = true;
  $('result').style.display = 'none';
  say('Refining… (everything runs in your browser)');
  const mode = (document.querySelector('input[name=mode]:checked') as HTMLInputElement).value;
  const key = $<HTMLInputElement>('aiKey').value.trim();
  const req: WorkerRequest = {
    id: ++jobId,
    name: picked.name,
    zip: picked.zip?.slice(0),
    entries: picked.entries?.map((e) => ({ path: e.path, data: e.data.slice(0) })),
    options: { mode, renameVariables: true, removeUnused: $<HTMLInputElement>('removeUnused').checked, aiKey: $<HTMLInputElement>('ai').checked && key ? key : undefined },
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
    say(`Saved ${last.files.length} files.`);
  } catch (e) {
    if ((e as Error).name !== 'AbortError') say((e as Error).message, true);
  }
});
