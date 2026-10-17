import type { RefactorLevel } from './types.js';
import { parseEcmaTarget } from './targets.js';

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
  poorName: number;
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
  /**
   * AI Advisor backend. Empty `model` / `baseUrl` / `apiKeyEnv` use the provider's defaults:
   * anthropic (ANTHROPIC_API_KEY), openai (OPENAI_API_KEY), gemini (GEMINI_API_KEY),
   * local = any OpenAI-compatible server such as Ollama or LM Studio (no key needed).
   */
  ai: {
    provider: 'anthropic' | 'openai' | 'gemini' | 'local';
    model: string;
    apiKeyEnv: string;
    baseUrl: string;
    timeoutMs: number;
  };
  /**
   * Top-level names of classic (non-module) scripts are globals that other code may use.
   * `never`: never rename them. `unreferenced`: rename those that no other file, inline handler or
   * `window.x` access mentions. `auto` (default): `unreferenced` in aggressive mode, `never` otherwise.
   */
  renameGlobals: 'auto' | 'never' | 'unreferenced';
  /**
   * Maximum language level per language id, e.g. `{ "javascript": "es5" }` or `"rhino"` (old Rhino engine:
   * ES5 syntax only, no trailing commas). Rules that would introduce newer syntax are switched off.
   * Rust: the edition passed to rustfmt (`2015` | `2018` | `2021` | `2024`).
   */
  target: Record<string, string>;
  /** Treat files with these extensions as another language, e.g. `{ ".rhino": "javascript", ".gs": "javascript" }`. */
  languageMap: Record<string, string>;
  /**
   * For files whose extension no Language Pack knows: look at the content (shebang, keywords, a parse
   * attempt) and refactor them as the best matching language anyway.
   */
  detectLanguageByContent: boolean;
  /**
   * Score an AI-suggested name must reach to be applied, in *every* mode (AI names are validated locally
   * and capped at recommend+2%). Set it above 1 to only ever report AI suggestions.
   */
  aiApplyThreshold: number;
  /** Language of the report and messages. `auto` follows the environment. */
  language: 'auto' | 'en' | 'ja';
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
    poorName: 5,
    abbreviation: 50,
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
  ai: { provider: 'anthropic', model: '', apiKeyEnv: '', baseUrl: '', timeoutMs: 30_000 },
  renameGlobals: 'auto',
  target: {},
  languageMap: {},
  detectLanguageByContent: false,
  aiApplyThreshold: 0.8,
  language: 'auto',
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
  if (!['anthropic', 'openai', 'gemini', 'local'].includes(c.ai.provider)) {
    throw new ConfigError(`ai.provider must be anthropic | openai | gemini | local (got "${c.ai.provider}")`);
  }
  if (!['auto', 'never', 'unreferenced'].includes(c.renameGlobals)) throw new ConfigError('renameGlobals must be auto | never | unreferenced');
  for (const [lang, t] of Object.entries(c.target)) {
    if (['javascript', 'typescript'].includes(lang)) {
      try {
        parseEcmaTarget(t);
      } catch (e) {
        throw new ConfigError((e as Error).message);
      }
    }
  }
  for (const [ext, lang] of Object.entries(c.languageMap)) {
    if (!ext.startsWith('.') || typeof lang !== 'string') throw new ConfigError(`languageMap keys must look like ".ext" (got "${ext}")`);
  }
  if (typeof c.aiApplyThreshold !== 'number' || c.aiApplyThreshold < 0) throw new ConfigError('aiApplyThreshold must be a number >= 0');
  if (!['auto', 'en', 'ja'].includes(c.language)) throw new ConfigError('language must be auto | en | ja');
  for (const key of ['ignore', 'omit', 'include', 'languagePacks'] as const) {
    if (!Array.isArray(c[key]) || c[key].some((x) => typeof x !== 'string')) {
      throw new ConfigError(`${key} must be an array of strings`);
    }
  }
  return c;
}

/** Deep-merges config fragments (later wins). Nested objects such as `thresholds` merge key by key. */
export function mergeConfigs(...parts: unknown[]): Record<string, unknown> {
  return parts.reduce<Record<string, unknown>>((acc, p) => merge(acc, p), {});
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
