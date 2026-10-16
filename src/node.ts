import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { unifiedDiff } from './core/diff.js';
import { resolveConfig, type Config } from './core/config.js';
import { resetDir, writeFiles } from './core/output.js';
import { scanInput } from './core/scan-node.js';
import { writeZip } from './core/zip.js';
import { refineProject, type RefineOptions, type RefineResult } from './pipeline.js';
import { renderReportHtml } from './report/html.js';

/** Scans `input` (ZIP or folder), refines it and writes original/, refined/, report and ZIP into outDir. */
export async function refine(input: string, outDir: string, configInput: Partial<Config> | Config = {}, options: RefineOptions = {}): Promise<RefineResult & { outDir: string }> {
  const config = resolveConfig(configInput);
  const project = await scanInput(input, config);
  const nodeModulesDir = options.nodeModulesDir ?? (project.source === 'folder' ? join(resolve(input), 'node_modules') : undefined);
  const result = await refineProject(project, config, { ...options, nodeModulesDir });
  await writeOutputs(result, outDir);
  return { ...result, outDir: resolve(outDir) };
}

export async function writeOutputs(result: RefineResult, outDir: string): Promise<void> {
  const out = resolve(outDir);
  await mkdir(out, { recursive: true });
  await resetDir(join(out, 'original'));
  await resetDir(join(out, 'refined'));
  const toList = (m: Map<string, Buffer>) => [...m.entries()].map(([path, data]) => ({ path, data }));
  await writeFiles(join(out, 'original'), toList(result.original));
  await writeFiles(join(out, 'refined'), toList(result.refined));
  await writeFile(join(out, 'refined-project.zip'), writeZip(toList(result.refined)));
  await writeFile(join(out, 'changes.diff'), result.diffs.map(unifiedDiff).join('\n'));
  await writeFile(join(out, 'report.json'), JSON.stringify(serializable(result), null, 2));
  await writeFile(join(out, 'report.html'), renderReportHtml(result));
}

export function serializable(result: RefineResult): unknown {
  const { refined: _refined, original: _original, ...rest } = result;
  return rest;
}
