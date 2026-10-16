/** Shared domain types for CodeRefiner. */

export type RefactorLevel = 'safe' | 'cautious' | 'aggressive';
export const LEVEL_ORDER: Record<RefactorLevel, number> = { safe: 0, cautious: 1, aggressive: 2 };

export interface Loc {
  line: number;
  column: number;
}

export type FileKind = 'text' | 'binary';

export interface ProjectFile {
  /** POSIX style path relative to the project root. */
  path: string;
  size: number;
  kind: FileKind;
  /** Language pack id, or a detected-but-unsupported language name. */
  language?: string;
  /** True when the file is excluded from analysis (still copied unless `omitted`). */
  ignored: boolean;
  /** True when the file is not copied into the refined project at all. */
  omitted: boolean;
  ignoreReason?: string;
  /** Text encoding detected for text files (default utf-8). */
  encoding?: string;
  /** Raw bytes (absent for omitted files). */
  data?: Buffer;
}

export interface Project {
  name: string;
  source: 'zip' | 'folder' | 'memory';
  files: ProjectFile[];
}

export type Runtime = 'browser' | 'node' | 'universal' | 'unknown';

export interface ValidationCommand {
  kind: 'build' | 'test' | 'typecheck' | 'lint';
  command: string;
  source: string;
}

export interface ProjectMetadata {
  name: string;
  runtime: Runtime;
  languages: string[];
  frameworks: string[];
  entryPoints: string[];
  packageManager?: string;
  scripts: Record<string, string>;
  typescript: boolean;
  tsconfig?: string;
  buildTools: string[];
  testRunners: string[];
  validationCommands: ValidationCommand[];
  /** Languages present in the project that have no Language Pack (copied untouched). */
  unsupportedLanguages: string[];
}

export interface Change {
  file: string;
  kind: 'format' | 'refactor' | 'rename' | 'remove' | 'markup' | 'style' | 'data';
  ruleId: string;
  level: RefactorLevel;
  description: string;
  loc?: Loc;
  before?: string;
  after?: string;
  /** 0..1 */
  confidence: number;
}

export interface NameCandidate {
  name: string;
  score: number;
  confidence: number;
  evidence: string[];
  usable: boolean;
  rejectedReason?: string;
}

export interface Suggestion {
  file: string;
  kind: 'rename' | 'dead-code' | 'duplicate' | 'complexity' | 'refactor' | 'cross-reference';
  message: string;
  loc?: Loc;
  confidence?: number;
  candidates?: NameCandidate[];
  details?: Record<string, unknown>;
}

export interface Warning {
  code: string;
  message: string;
  file?: string;
}
