/**
 * Optional AI Advisor. The advisor only ever sees a minimal, local context for a
 * single decision. Its answer is checked again locally (identifier validity, collisions,
 * confidence thresholds); it never has the final say.
 */
export interface NamingAdviceRequest {
  file: string;
  kind: 'variable' | 'parameter' | 'function';
  currentName: string;
  valueType: string;
  /** Truncated declaration, never the whole file. */
  context?: string;
  /** A few usages of the name (statements around each reference). */
  usages?: string[];
  enclosingFunction?: string;
  candidates: { name: string; score: number; evidence: string[] }[];
  /** Top project vocabulary words. */
  vocabulary: string[];
  /** Detected project convention, e.g. "camelCase; collections: xxxList". */
  convention?: string;
  /** Language for the rationale text. */
  language?: 'en' | 'ja';
}

export interface NamingAdvice {
  /** One of the candidate names, or null when none is clearly right. */
  choice: string | null;
  /** A new name suggested by the model. Only used after local validation, at a capped confidence. */
  proposal?: string;
  rationale?: string;
}

export interface AIAdvisor {
  id: string;
  adviseName(req: NamingAdviceRequest): Promise<NamingAdvice | null>;
}

const IDENT = /^[\p{ID_Start}_$][\p{ID_Continue}$]*$/u;

/** Parses an advisor reply defensively. A choice must be one of the offered candidates. */
export function parseAdvice(text: string, allowed: string[]): NamingAdvice | null {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]) as { choice?: unknown; proposal?: unknown; rationale?: unknown };
    const rationale = typeof obj.rationale === 'string' ? obj.rationale.slice(0, 240) : undefined;
    const proposal = typeof obj.proposal === 'string' && IDENT.test(obj.proposal) && obj.proposal.length <= 40 ? obj.proposal : undefined;
    if (obj.choice === null || obj.choice === undefined) return { choice: null, proposal, rationale };
    if (typeof obj.choice === 'string' && allowed.includes(obj.choice)) return { choice: obj.choice, proposal, rationale };
    if (proposal) return { choice: null, proposal, rationale };
  } catch {
    /* fallthrough */
  }
  return null;
}
