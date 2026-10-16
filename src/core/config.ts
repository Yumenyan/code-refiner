import type { RefactorLevel } from './types.js';

export interface NamingWeights {
  sourceMatch: number;
  methodMatch: number;
  propertyMatch: number;
  usageMatch: number;
  typeMatch: number;
  conventionMatch: number;
  vocabularyMatch: number;
  contextMatch: number;
  nameHint: number;
  abbreviation: number;
  ambiguousName: number;
  collision: number;
  contextMismatch: number;
}

export interface Thresholds {
  /** >= : applied automatically (in every mode that renames). */
  autoApply: number;
  /** >= : "recommended" - applied in cautious/aggressive mode. */
  recommend: number;
  /** >= : shown as a candidate in the report. Below: never shown, never applied. */
  suggest: number;
}

export interface ComplexityLimits {
  maxFunctionLines: number;
  maxNesting: number;
  maxParams: number;
  maxCyclomatic: number;
}

export interface Config {
  mode: RefactorLevel;
  renameVariables: boolean;
  removeUnused: boolean;
  /** Currently report-only: duplicates are detected and listed, never auto-merged. */
  refactorDuplicates: boolean;
  aiAdvisor: boolean;
  validation: boolean;

  thresholds: Thresholds;
  /** Overrides the mode-derived threshold for applying renames (0..1). */
  renameApplyThreshold?: number;
  namingWeights: NamingWeights;
  complexity: ComplexityLimits;

  /** Extra glob patterns: not analysed / not changed, but copied. */
  ignore: string[];
  /** Extra glob patterns: not copied into the refined project. */
  omit: string[];
  /** Patterns that re-include something the defaults would ignore/omit. */
  include: string[];
  /** Files larger than this are copied untouched. */
  maxFileSizeBytes: number;

  validationOptions: {
    typecheck: boolean;
    /** Runs build/test scripts of the project. Executes project code - opt-in. */
    runCommands: boolean;
    commandTimeoutMs: number;
  };
  ai: {
    provider: 'anthropic';
    model: string;
    apiKeyEnv: string;
    baseUrl: string;
    timeoutMs: number;
  };
  /** Paths/modules of external Language Packs to load. */
  languagePacks: string[];
}

export const DEFAULT_CONFIG: Config = {
  mode: 'safe',
  renameVariables: true,
  removeUnused: false,
  refactorDuplicates: false,
  aiAdvisor: false,
  validation: true,
  thresholds: { autoApply: 0.95, recommend: 0.8, suggest: 0.5 },
  namingWeights: {
    sourceMatch: 30,
    methodMatch: 20,
    propertyMatch: 20,
    usageMatch: 15,
    typeMatch: 10,
    conventionMatch: 10,
    vocabularyMatch: 5,
    contextMatch: 5,
    nameHint: 15,
    abbreviation: 45,
    ambiguousName: -30,
    collision: -20,
    contextMismatch: -20,
  },
  complexity: { maxFunctionLines: 60, maxNesting: 4, maxParams: 5, maxCyclomatic: 12 },
  ignore: [],
  omit: [],
  include: [],
  maxFileSizeBytes: 2 * 1024 * 1024,
  validationOptions: { typecheck: true, runCommands: false, commandTimeoutMs: 120_000 },
  ai: {
    provider: 'anthropic',
    model: 'claude-haiku-5-5',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    baseUrl: 'https://api.anthropic.com',
    timeoutMs: 30_000,
  },
  languagePacks: [],
};

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function merge<T>(base: T, patch: unknown): T {
  if (!isObject(patch) || !isObject(base)) return (patch === undefined ? base : (patch as T));
  const out: Json = { ...(base as Json) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isObject(v) && isObject(out[k]) ? merge(out[k], v) : v;
  }
  return out as T;
}

export class ConfigError extends Error {}

export function validateConfig(c: Config): Config {
  if (!['safe', 'cautious', 'aggressive'].includes(c.mode)) {
    throw new ConfigError(`mode must be safe | cautious | aggressive (got "${c.mode}")`);
  }
  const t = c.thresholds;
  if (!(t.suggest <= t.recommend && t.recommend <= t.autoApply && t.autoApply <= 1 && t.suggest >= 0)) {
    throw new ConfigError('thresholds must satisfy 0 <= suggest <= recommend <= autoApply <= 1');
  }
  for (const key of ['ignore', 'omit', 'include', 'languagePacks'] as const) {
    if (!Array.isArray(c[key]) || c[key].some((x) => typeof x !== 'string')) {
      throw new ConfigError(`${key} must be an array of strings`);
    }
  }
  return c;
}

export function resolveConfig(partial: unknown = {}): Config {
  return validateConfig(merge(DEFAULT_CONFIG, partial));
}

export async function loadConfigFile(path: string): Promise<Config> {
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`Invalid JSON in ${path}: ${(e as Error).message}`);
  }
  return resolveConfig(parsed);
}

/** The score a rename must reach to be applied under a given config. */
export function renameApplyThreshold(c: Config): number {
  if (c.renameApplyThreshold !== undefined) return c.renameApplyThreshold;
  return c.mode === 'safe' ? c.thresholds.autoApply : c.thresholds.recommend;
}
