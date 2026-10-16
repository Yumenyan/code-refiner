import type { Config } from '../core/config.js';
import type { Change, Suggestion, Warning, RefactorLevel } from '../core/types.js';
import type { NamingContext } from '../naming/engine.js';
import type { FileModels } from '../semantic/model.js';
import type { AIAdvisor } from '../ai/advisor.js';
import type { Rule } from '../core/rule-engine.js';

export interface SyntaxOutcome {
  ok: boolean;
  error?: string;
}

/** Wraps an external formatter (Prettier, rustfmt, Black, ...). The core never imports one directly. */
export interface FormatterAdapter {
  id: string;
  /** Returns formatted text. May throw if the input cannot be parsed. */
  format(source: string, file: string): Promise<string>;
}

/**
 * Turns a (possibly modified) syntax tree back into source text.
 * Printers should preserve the formatting of untouched code so diffs stay small.
 */
export interface CodePrinter<Tree> {
  id: string;
  print(tree: Tree, originalSource: string): string;
}

/** Project-wide information available while refining a single file. */
export interface ProjectContext {
  naming: NamingContext;
  /** Global names that other files (HTML handlers, window.x ...) rely on. Never renamed. */
  protectedNames: Set<string>;
  advisor?: AIAdvisor;
  /** Whether top-level names of classic scripts may be renamed at all (see Config.renameGlobals). */
  globalPolicy?: 'never' | 'unreferenced';
  /** True when another file (or an inline handler) mentions `name`. */
  usedElsewhere?: (name: string, file: string) => boolean;
  /** Language for AI rationales and messages. */
  language?: 'en' | 'ja';
  /** Detected naming convention in words, for the AI prompt. */
  conventionNote?: string;
  /** Refines a code fragment embedded in another file (e.g. <script> in HTML). */
  refineEmbedded?: (language: string, source: string, opts: EmbeddedOptions) => Promise<RefineOutput>;
}

export interface EmbeddedOptions {
  file: string;
  isModule?: boolean;
}

export interface RefineInput {
  file: string;
  source: string;
  config: Config;
  project: ProjectContext;
  /** Set for fragments embedded in another document. */
  embedded?: EmbeddedOptions;
}

export interface RefineOutput {
  code: string;
  changes: Change[];
  suggestions: Suggestion[];
  warnings: Warning[];
  /** Public names (e.g. `global:foo`) the pack changed on purpose; the validation gate must not flag them. */
  surfaceChanges?: string[];
}

export interface AnalyzeInput {
  file: string;
  source: string;
}

/**
 * A Language Pack bundles everything language specific: syntax check, semantic
 * analysis, refactoring rules, formatting. The core only talks to this interface.
 */
export interface LanguagePack {
  id: string;
  displayName: string;
  extensions: string[];
  formatter: FormatterAdapter;
  /** Introspection: the rules this pack applies, per level. */
  rules: Pick<Rule<unknown>, 'id' | 'description' | 'level'>[];

  /** Loads parsers / WebAssembly before first use. Awaited by the pipeline for every pack a project needs. */
  init?(): Promise<void>;
  checkSyntax(source: string, file: string): Promise<SyntaxOutcome> | SyntaxOutcome;
  /** Extracts semantic information for project-wide analyses. Must not throw on bad input. */
  analyze?(input: AnalyzeInput): FileModels;
  refine(input: RefineInput): Promise<RefineOutput>;
  /**
   * Verifies that a purely cosmetic transformation did not change meaning.
   * Return undefined when the pack cannot tell.
   */
  isEquivalent?(before: string, after: string, file: string): boolean | undefined;
  /** Files that must exist unchanged in surface (e.g. exported names). Returns a fingerprint. */
  surface?(source: string, file: string): string[] | undefined;
}

export type { RefactorLevel };
