import { UI_STRINGS, detectUiLang, type UiLang } from './strings.js';

export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface AiOptions {
  enabled: boolean;
  provider: 'anthropic' | 'openai' | 'gemini' | 'local';
  model: string;
  baseUrl: string;
  key: string;
}

export interface Ui {
  lang: UiLang;
  t(key: string, params?: Record<string, string | number>): string;
  say(text: string, err?: boolean): void;
  ai(): AiOptions;
}

const PLACEHOLDERS: Record<string, { model: string; base: string }> = {
  anthropic: { model: 'claude-haiku-5-5', base: 'https://api.anthropic.com' },
  openai: { model: 'gpt-4o-mini', base: 'https://api.openai.com/v1' },
  gemini: { model: 'gemini-2.0-flash', base: 'https://generativelanguage.googleapis.com/v1beta' },
  local: { model: 'llama3.2', base: 'http://localhost:11434/v1' },
};

/** Applies translations, wires the language selector and the AI settings box. */
export function initUi(): Ui {
  let lang: UiLang = (() => {
    try {
      const saved = localStorage.getItem('coderefiner.lang');
      if (saved === 'en' || saved === 'ja') return saved;
    } catch {
      /* storage may be blocked */
    }
    return detectUiLang();
  })();
  const t = (key: string, params: Record<string, string | number> = {}) =>
    (UI_STRINGS[lang][key] ?? UI_STRINGS.en[key] ?? key).replace(/\{(\w+)\}/g, (_m, k: string) => String(params[k] ?? ''));
  const apply = () => {
    document.documentElement.lang = lang;
    document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
      el.textContent = t(el.dataset.i18n!);
    });
    $<HTMLSelectElement>('lang').value = lang;
  };
  $('lang').addEventListener('change', () => {
    lang = $<HTMLSelectElement>('lang').value as UiLang;
    try {
      localStorage.setItem('coderefiner.lang', lang);
    } catch {
      /* ignore */
    }
    apply();
  });
  apply();

  const aiToggle = $<HTMLInputElement>('ai');
  const provider = $<HTMLSelectElement>('aiProvider');
  const sync = () => {
    $('aiBox').style.display = aiToggle.checked ? 'block' : 'none';
    const p = PLACEHOLDERS[provider.value];
    $<HTMLInputElement>('aiModel').placeholder = p.model;
    $<HTMLInputElement>('aiBase').placeholder = p.base;
    $('keyRow').style.display = provider.value === 'local' ? 'none' : 'block';
    $('localNote').style.display = provider.value === 'local' ? 'block' : 'none';
  };
  aiToggle.addEventListener('change', sync);
  provider.addEventListener('change', sync);
  sync();

  const msg = $('msg');
  return {
    get lang() {
      return lang;
    },
    t,
    say(text, err = false) {
      msg.textContent = text;
      msg.className = err ? 'err' : '';
    },
    ai: () => ({
      enabled: aiToggle.checked,
      provider: provider.value as AiOptions['provider'],
      model: $<HTMLInputElement>('aiModel').value.trim(),
      baseUrl: $<HTMLInputElement>('aiBase').value.trim(),
      key: $<HTMLInputElement>('aiKey').value.trim(),
    }),
  };
}

/** Minimal STORE-only ZIP writer so a dropped folder can be sent as one upload. */
const CRC = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

export function zipStore(entries: { name: string; data: Uint8Array }[]): Blob {
  const enc = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: BlobPart[] = [];
  let offset = 0;
  let csize = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const c = crc32(e.data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 0x0800, true);
    h.setUint32(14, c, true);
    h.setUint32(18, e.data.length, true);
    h.setUint32(22, e.data.length, true);
    h.setUint16(26, name.length, true);
    parts.push(h.buffer, name, e.data as BlobPart);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint32(16, c, true);
    ch.setUint32(20, e.data.length, true);
    ch.setUint32(24, e.data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    csize += 46 + name.length;
    offset += 30 + name.length + e.data.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, csize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

export interface PickedFiles {
  name: string;
  label: string;
  entries?: { path: string; data: ArrayBuffer }[];
  zip?: ArrayBuffer;
}

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

/** Drop zone / pickers shared by both UIs. Calls `onPick` with the chosen files. */
export function initPicker(ui: Ui, onPick: (p: PickedFiles) => void): void {
  const drop = $('drop');
  const fromZip = async (f: File) => onPick({ name: f.name.replace(/\.zip$/i, ''), label: `${f.name} (${Math.round(f.size / 1024)} KB)`, zip: await f.arrayBuffer() });
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
    if (f) void fromZip(f);
  });
  $<HTMLInputElement>('folderInput').addEventListener('change', async (e) => {
    const files = [...((e.target as HTMLInputElement).files ?? [])];
    if (!files.length) return;
    ui.say(ui.t('reading'));
    const root = files[0].webkitRelativePath.split('/')[0] || 'project';
    const entries = await Promise.all(files.map(async (f) => ({ path: f.webkitRelativePath.split('/').slice(1).join('/') || f.name, data: await f.arrayBuffer() })));
    onPick({ name: root, label: `${root}/ (${files.length})`, entries });
  });
  ['dragenter', 'dragover'].forEach((n) => drop.addEventListener(n, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((n) => drop.addEventListener(n, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', async (e) => {
    const entry = e.dataTransfer?.items[0]?.webkitGetAsEntry?.();
    if (entry?.isDirectory) {
      ui.say(ui.t('reading'));
      const out: { path: string; data: ArrayBuffer }[] = [];
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((ok, fail) => reader.readEntries(ok, fail));
        if (!batch.length) break;
        for (const c of batch) await readEntry(c, '', out);
      }
      onPick({ name: entry.name, label: `${entry.name}/ (${out.length})`, entries: out });
      return;
    }
    const f = e.dataTransfer?.files[0];
    if (f && /\.zip$/i.test(f.name)) await fromZip(f);
    else ui.say(ui.t('badDrop'), true);
  });
}
