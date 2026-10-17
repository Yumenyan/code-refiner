import type { SyntaxNode } from './runtime.js';

/**
 * A conservative layout pass for brace languages (Rust, Java, C#, C/C++, Go, Kotlin, Swift, PHP, Scala)
 * for machines without a native formatter (and for the browser). It only ever changes whitespace:
 *   - statements and block bodies are put on their own lines (`{ a; b; }` -> three lines),
 *   - lines are re-indented by block depth (hanging brackets and continuation lines get one more level),
 *   - runs of spaces collapse; `,` and `;` lose a leading space, `,` gets a trailing one, `) {` / `} else` get one.
 * Strings, comments, preprocessor lines, attributes and annotations are copied verbatim. The caller proves
 * the result with the token stream and the tree shape, so a mistake can never change the program.
 */
export interface ReflowOptions {
  indent: string;
  /** Put every statement of a block on its own line. */
  splitStatements: boolean;
}

const ATOMIC = /(^|_)(string|char|comment|raw_string|template_string|template_literal|regex|heredoc|preproc|attribute_item|attribute_list|inner_attribute_item|annotation|marker_annotation|macro_definition|verbatim|interpolated|shebang|character)/;
const BLOCKISH = /(^block$|_block$|^compound_statement$|declaration_list$|field_declaration_list$|statement_list$|class_body$|enum_body$|interface_body$|^body$|function_body$|switch_body$|match_block$|enum_variant_list$|namespace_body|object_body|trait_body|impl_body)/;
const NOT_BLOCKISH = /(initializer|struct_expression|object|array|dictionary|map|set_literal|composite_literal|literal_value|lambda|closure|func_literal|anonymous_function|arrow|template|use_list|import|attribute|token_tree)/;

interface Tok {
  text: string;
  start: number;
  end: number;
  row: number;
  endRow: number;
  atomic: boolean;
  comment: boolean;
  blockBrace: boolean;
  parentType: string;
}

function collect(root: SyntaxNode, source: string): Tok[] {
  const out: Tok[] = [];
  const walk = (n: SyntaxNode): void => {
    const atomic = n.type !== 'source_file' && ATOMIC.test(n.type) && !/^(string_content|escape)/.test(n.type);
    if (atomic || n.childCount === 0) {
      if (!n.text.trim()) return; // zero width or whitespace-only (implicit / automatic semicolons)
      const p = n.parent;
      out.push({
        text: n.text,
        start: n.startIndex,
        end: n.endIndex,
        row: n.startPosition.row,
        endRow: n.endPosition.row,
        atomic,
        comment: /comment/.test(n.type),
        blockBrace: n.type === '{' && !!p && BLOCKISH.test(p.type) && !NOT_BLOCKISH.test(p.type) && !(p.parent && /closure|lambda|func_literal|arrow/.test(p.parent.type)),
        parentType: p?.type ?? '',
      });
      return;
    }
    for (let i = 0; i < n.childCount; i++) walk(n.child(i)!);
  };
  walk(root);
  return withHiddenTokens(out, source);
}

/**
 * Text between two tokens that is not whitespace (a `;` some grammars hide, a stray character ...) must
 * not be lost: it becomes a token of its own, so it is copied like everything else.
 */
function withHiddenTokens(toks: Tok[], source: string): Tok[] {
  const out: Tok[] = [];
  let pos = 0;
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const rowOf = (index: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const addGap = (from: number, to: number) => {
    const gap = source.slice(from, to);
    for (const m of gap.matchAll(/\S+/g)) {
      const start = from + m.index!;
      const row = rowOf(start);
      out.push({ text: m[0], start, end: start + m[0].length, row, endRow: row, atomic: false, comment: false, blockBrace: false, parentType: '' });
    }
  };
  for (const t of toks) {
    if (t.start > pos) addGap(pos, t.start);
    out.push(t);
    pos = Math.max(pos, t.end);
  }
  if (pos < source.length) addGap(pos, source.length);
  return out;
}

const isWord = (s: string) => /^[\p{L}\p{N}_$'"#@\\]/u.test(s);
const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);
const CONTINUES_AFTER_BRACE = /^(else|catch|finally|while|elif|where|until|rescue|ensure)$/;
const HEADER = new Set(['for', 'if', 'switch', 'while', 'select']);
const CONTINUING_START = /^(\.|\?|:|\+|-|\*|\/|%|&&|\|\||&|\||\^|<|>|=|!=|=>|->|where)/;
const CONTINUING_END = /^(=|\+|-|\*|\/|%|&&|\|\||&|\||\^|<|>|\?|:|=>|->|\.|\+=|-=|:=|==|!=)$/;
const ONE_PER_LINE = /^(match_block|enum_variant_list|field_declaration_list|enum_body|enum_member_declaration_list)$/;
const KEYWORD_PAREN = new Set(['if', 'for', 'while', 'switch', 'match', 'catch', 'foreach', 'when', 'elif', 'return', 'synchronized', 'using', 'lock']);
const SPACED_OPS = new Set(['=', '==', '!=', '<=', '>=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '=>', '->', ':=', '|=', '&=', '^=', '<<=', '>>=', '===', '!==']);

function reindentComment(text: string): string {
  if (!text.startsWith('/*') || !text.includes('\n')) return text;
  const lines = text.split('\n');
  if (!lines.slice(1).every((l) => /^\s*\*/.test(l))) return text;
  return [lines[0], ...lines.slice(1).map((l) => `\u0001 ${l.trim()}`)].join('\n');
}

export function reflow(source: string, root: SyntaxNode, opts: ReflowOptions): string {
  const toks = collect(root, source);
  if (!toks.length) return source;
  const n = toks.length;

  // ---- pass 1: where does a new line start? --------------------------------------------------
  const brk: boolean[] = toks.map((t, i) => i === 0 || /\n/.test(source.slice(toks[i - 1].end, t.start)));
  const blankBefore: boolean[] = toks.map((t, i) => i > 0 && (source.slice(toks[i - 1].end, t.start).match(/\n/g) ?? []).length > 1);
  if (opts.splitStatements) {
    const stack: { block: boolean }[] = [];
    let headerDepth = -1;
    for (let i = 0; i < n - 1; i++) {
      const tok = toks[i];
      const next = toks[i + 1];
      if (HEADER.has(tok.text) && !tok.atomic && headerDepth < 0) headerDepth = stack.length;
      let closed: { block: boolean } | undefined;
      if (tok.text === '{' && headerDepth === stack.length) headerDepth = -1;
      if (OPEN.has(tok.text)) stack.push({ block: tok.blockBrace });
      else if (CLOSE.has(tok.text)) closed = stack.pop();
      if (brk[i + 1]) continue;
      const top = stack[stack.length - 1];
      const sameLineComment = next.comment || (next.atomic && /^(\/\/|\/\*)/.test(next.text));
      if (tok.text === '{' && tok.blockBrace && next.text !== '}' && !sameLineComment) brk[i + 1] = true;
      else if (tok.text === ',' && ONE_PER_LINE.test(tok.parentType) && !sameLineComment && next.text !== '}') brk[i + 1] = true;
      else if (tok.text === ';' && (!top || top.block) && headerDepth < 0 && !sameLineComment && next.text !== '}') brk[i + 1] = true;
      else if (next.text === '}' && top?.block && tok.text !== '{') brk[i + 1] = true;
      else if (tok.text === '}' && closed?.block && !sameLineComment && isWord(next.text) && !CONTINUES_AFTER_BRACE.test(next.text)) brk[i + 1] = true;
    }
  }

  // ---- pass 2: indentation and spacing -----------------------------------------------------------
  type Line = { indent: number; text: string };
  const lines: Line[] = [];
  const stack: { hanging: boolean }[] = [];
  let cur: Line | null = null;
  let prevSig: Tok | null = null;
  for (let i = 0; i < n; i++) {
    const tok = toks[i];
    const prev = i > 0 ? toks[i - 1] : null;
    const next = toks[i + 1];
    if (brk[i] || !cur) {
      if (blankBefore[i]) lines.push({ indent: 0, text: '' });
      let level = stack.filter((f) => f.hanging).length;
      if (CLOSE.has(tok.text) && stack.length && stack[stack.length - 1].hanging) level--;
      const originalBreak = i > 0 && /\n/.test(source.slice(toks[i - 1].end, tok.start));
      // A wrapped expression: the line starts with an operator / `.method()`, or the previous one ended with an operator.
      const continuation =
        originalBreak && !!prevSig && !prevSig.atomic && !CLOSE.has(tok.text) && tok.text !== '{' && (CONTINUING_START.test(tok.text) || CONTINUING_END.test(prevSig.text));
      if (continuation) level += 1;
      const preproc = tok.atomic && /^#/.test(tok.text) && tok.parentType.startsWith('preproc');
      cur = { indent: preproc ? 0 : Math.max(0, level), text: '' };
      lines.push(cur);
    } else if (prev) {
      const gap = source.slice(prev.end, tok.start);
      let sep = '';
      if (tok.text === ',' || tok.text === ';') sep = '';
      else if (prev.text === ',') sep = ' ';
      else if (tok.text === '{' && (tok.blockBrace || /struct_expression|field_initializer_list|object_creation_expression/.test(tok.parentType)) && !OPEN.has(prev.text) && prev.text !== '!' && !(prev.atomic && prev.text.startsWith('#'))) sep = ' ';
      else if (prev.text === '}' && isWord(tok.text)) sep = ' ';
      else if (prev.text === ';') sep = ' ';
      else if (SPACED_OPS.has(tok.text) || SPACED_OPS.has(prev.text)) sep = OPEN.has(prev.text) || CLOSE.has(tok.text) ? '' : ' ';
      else if (prev.text === ':' && tok.text !== ':' && !CLOSE.has(tok.text)) sep = ' ';
      else if (tok.text === '(' && KEYWORD_PAREN.has(prev.text) && !prev.atomic) sep = ' ';
      else if (/[ \t]/.test(gap)) sep = ' ';
      cur.text += sep;
    }
    cur.text += tok.comment ? reindentComment(tok.text) : tok.text;
    if (OPEN.has(tok.text)) stack.push({ hanging: !!next && brk[i + 1] });
    else if (CLOSE.has(tok.text)) stack.pop();
    if (!tok.comment) prevSig = tok;
  }
  const out = lines.map((l) => (l.text === '' ? '' : `${opts.indent.repeat(l.indent)}${l.text}`.replace(/\u0001/g, opts.indent.repeat(l.indent)).replace(/[ \t]+$/g, '')));
  return out.join('\n') + '\n';
}
