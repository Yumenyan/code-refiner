import type { Loc } from '../core/types.js';

/** Language neutral semantic model. Language packs fill it; core analyses consume it. */

export interface VariableInfo {
  id: string;
  name: string;
  file: string;
  kind: 'var' | 'let' | 'const' | 'param' | 'function' | 'class' | 'import' | 'catch';
  scope: string;
  scopeKind: 'module' | 'global' | 'function' | 'block';
  loc: Loc;
  valueType?: string;
  /** Short source text of the initializer (truncated). */
  init?: string;
  /** Variables / external names this variable's value derives from. */
  sources: string[];
  references: Loc[];
  assignments: number;
  exported: boolean;
}

export interface FunctionInfo {
  id: string;
  name: string;
  file: string;
  loc: Loc;
  params: string[];
  returnsValue: boolean;
  async: boolean;
  generator: boolean;
  exported: boolean;
  lines: number;
  cyclomatic: number;
  maxNesting: number;
  /** Callee labels (resolved function ids when known, otherwise `?name`). */
  calls: string[];
}

export interface ImportInfo {
  source: string;
  resolved?: string;
  specifiers: { imported: string; local: string }[];
  loc: Loc;
  sideEffectOnly: boolean;
}

export interface ExportInfo {
  name: string;
  kind: 'named' | 'default' | 'reexport' | 'all' | 'commonjs';
  source?: string;
  loc: Loc;
}

export interface ModuleInfo {
  file: string;
  isModule: boolean;
  imports: ImportInfo[];
  exports: ExportInfo[];
}

export interface DataFlowEdge {
  file: string;
  from: string;
  to: string;
  via: string;
  loc: Loc;
}

export interface CallEdge {
  file: string;
  caller: string;
  callee: string;
  loc: Loc;
}

export type DomRefKind =
  | 'id'
  | 'class'
  | 'selector'
  | 'data'
  | 'event'
  | 'handler-global'
  | 'tag';

export interface DomRef {
  file: string;
  kind: DomRefKind;
  value: string;
  loc: Loc;
  /** For events: the handler function name (when it is a plain identifier). */
  handler?: string;
  event?: string;
  /** Element target (id / selector) the event is registered on. */
  target?: string;
}

export interface UnreachableCode {
  file: string;
  loc: Loc;
  reason: string;
}

export interface FileSemantic {
  file: string;
  language: string;
  variables: VariableInfo[];
  functions: FunctionInfo[];
  module: ModuleInfo;
  dataFlow: DataFlowEdge[];
  calls: CallEdge[];
  domRefs: DomRef[];
  unreachable: UnreachableCode[];
  /** String literal values found in the file (used for dynamic-use heuristics). */
  strings: string[];
  /** Normalised function body hashes for duplicate detection. */
  functionHashes: { id: string; name: string; loc: Loc; hash: string; size: number; lines: number }[];
  hasDynamicScope: boolean;
  /** Every identifier-like name in the file with its occurrence count (declarations, properties, references). */
  identifierCounts: Record<string, number>;
}

export interface HtmlElementInfo {
  tag: string;
  id?: string;
  classes: string[];
  dataAttrs: string[];
  loc: Loc;
}

export interface HtmlHandlerInfo {
  event: string;
  code: string;
  /** Plain function names called in the handler code. */
  calls: string[];
  elementId?: string;
  loc: Loc;
}

export interface HtmlFileModel {
  file: string;
  elements: HtmlElementInfo[];
  handlers: HtmlHandlerInfo[];
  scripts: { src?: string; inline: boolean; module: boolean; loc: Loc }[];
  styles: { href?: string; inline: boolean; loc: Loc }[];
  duplicateIds: string[];
  /** Relative URLs referenced by src/href/poster/srcset attributes. */
  refs: string[];
}

export interface CssSelectorInfo {
  selector: string;
  loc: Loc;
  classes: string[];
  ids: string[];
  dataAttrs: string[];
  tags: string[];
  /** True if the selector contains something we cannot reason about (e.g. `:is(...)` with args). */
  opaque: boolean;
}

export interface CssFileModel {
  file: string;
  selectors: CssSelectorInfo[];
  customPropsDeclared: { name: string; loc: Loc }[];
  customPropsUsed: string[];
  keyframes: { name: string; loc: Loc }[];
  animationNamesUsed: string[];
  imports: string[];
  /** Declaration-block hashes for duplicate detection. */
  blockHashes: { hash: string; selector: string; loc: Loc; decls: number }[];
}

export interface FileModels {
  semantic?: FileSemantic;
  html?: HtmlFileModel;
  css?: CssFileModel;
}
