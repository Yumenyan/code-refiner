import { resolveConfig, type Config } from '../../src/core/config.js';
import { scanEntries } from '../../src/core/scanner.js';
import { refineProject, type RefineResult } from '../../src/pipeline.js';

export function memProject(files: Record<string, string | Buffer>, cfg: Partial<Config> = {}) {
  return scanEntries(
    'test',
    Object.entries(files).map(([path, data]) => ({ path, data: Buffer.isBuffer(data) ? data : Buffer.from(data) })),
    resolveConfig(cfg),
  );
}

export async function run(files: Record<string, string | Buffer>, cfg: Partial<Config> = {}, options = {}): Promise<RefineResult> {
  return refineProject(memProject(files, cfg), cfg, options);
}

export const text = (r: RefineResult, path: string) => r.refined.get(path)!.toString('utf8');
