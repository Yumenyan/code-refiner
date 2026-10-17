/// <reference lib="webworker" />
// Browser build: everything runs locally in this worker. No project file ever leaves the machine
// (the optional AI Advisor sends minimal naming context to Anthropic with the user's own key).
import * as standalone from 'prettier/standalone';
import * as babel from 'prettier/plugins/babel';
import * as estree from 'prettier/plugins/estree';
import * as graphql from 'prettier/plugins/graphql';
import * as html from 'prettier/plugins/html';
import * as markdown from 'prettier/plugins/markdown';
import * as postcss from 'prettier/plugins/postcss';
import * as typescript from 'prettier/plugins/typescript';
import * as yaml from 'prettier/plugins/yaml';
import { createAdvisor } from '../ai/anthropic.js';
import { resolveConfig } from '../core/config.js';
import { unifiedDiff } from '../core/diff.js';
import { scanEntries, scanZipBuffer } from '../core/scanner.js';
import { writeZip } from '../core/zip.js';
import { createRegistry } from '../languages/index.js';
import { configurePrettier } from '../languages/prettier-api.js';
import { configureTreeSitter } from '../languages/treesitter/runtime.js';
import { refineProject } from '../pipeline.js';
import { renderReportHtml } from '../report/html.js';
import { translateMessage } from '../i18n/ja.js';

const plugins = [babel, estree, graphql, html, markdown, postcss, typescript, yaml];
configurePrettier({ format: (source, options) => standalone.format(source, { ...options, plugins } as never) });

const base = new URL('./', self.location.href).href;
configureTreeSitter(
  async (name) => {
    const res = await fetch(`${base}wasm/${name}`);
    if (!res.ok) throw new Error(`Could not load ${name}`);
    return new Uint8Array(await res.arrayBuffer());
  },
  { initOptions: { locateFile: (f: string) => `${base}wasm/${f}` } },
);

export interface WorkerRequest {
  id: number;
  name: string;
  zip?: ArrayBuffer;
  entries?: { path: string; data: ArrayBuffer }[];
  options: {
    mode: string;
    renameVariables: boolean;
    removeUnused: boolean;
    language: 'en' | 'ja';
    ai?: { provider: 'anthropic' | 'openai' | 'gemini' | 'local'; model: string; baseUrl: string; key: string };
    /** Advanced settings from the page (merged over the defaults). */
    config?: Record<string, unknown>;
  };
}

export type WorkerMessage = WorkerResult | { type: 'log' | 'error'; id: number; message: string };

export interface WorkerResult {
  type: 'done';
  id: number;
  stats: { files: number; changed: number; warnings: number; renames: number; rolledBack: number };
  report: string;
  diff: string;
  files: { path: string; data: ArrayBuffer }[];
  zip: ArrayBuffer;
  aiNote: string;
  warnings: string[];
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  const post = (m: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);
  try {
    const config = resolveConfig({
      ...(req.options.config ?? {}),
      mode: req.options.mode,
      renameVariables: req.options.renameVariables,
      removeUnused: req.options.removeUnused,
      aiAdvisor: !!req.options.ai,
      language: req.options.language,
      ai: req.options.ai ? { provider: req.options.ai.provider, model: req.options.ai.model, baseUrl: req.options.ai.baseUrl, apiKeyEnv: '', timeoutMs: 60_000 } : undefined,
      validationOptions: { typecheck: false, runCommands: false, commandTimeoutMs: 1000 },
      ...(req.options.config?.thresholds ? { thresholds: { ...resolveConfig({}).thresholds, ...(req.options.config.thresholds as object) } } : {}),
    });
    const project = req.zip
      ? scanZipBuffer(new Uint8Array(req.zip), req.name, config)
      : scanEntries(req.name, (req.entries ?? []).map((e) => ({ path: e.path, data: new Uint8Array(e.data) })), config, 'folder');
    const registry = await createRegistry({ native: false });
    const setup = createAdvisor(config, {}, { apiKey: req.options.ai?.key, fetchImpl: fetch.bind(globalThis), browser: true });
    const result = await refineProject(project, config, { registry, advisor: setup.advisor, log: (m) => post({ type: 'log', id: req.id, message: m }) });
    const files = [...result.refined.entries()].map(([path, data]) => ({ path, data: new Uint8Array(data).buffer as ArrayBuffer }));
    const zip = writeZip([...result.refined.entries()].map(([path, data]) => ({ path, data })));
    const out: WorkerResult = {
      type: 'done',
      id: req.id,
      stats: { files: result.stats.totalFiles, changed: result.stats.changedFiles, warnings: result.stats.warnings, renames: result.stats.renames, rolledBack: result.stats.rolledBack },
      report: renderReportHtml(result, req.options.language),
      diff: result.diffs.map(unifiedDiff).join('\n'),
      files,
      zip: zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer,
      aiNote: config.aiAdvisor && !result.aiUsed ? translateMessage(setup.warning ?? 'AI Advisor was requested but could not be used.', req.options.language) : '',
      warnings: result.warnings.slice(0, 20).map((w) => `${w.file ? w.file + ': ' : ''}${translateMessage(w.message, req.options.language)}`),
    };
    post(out, [out.zip, ...files.map((f) => f.data)]);
  } catch (e) {
    post({ type: 'error', id: req.id, message: (e as Error).message });
  }
};
