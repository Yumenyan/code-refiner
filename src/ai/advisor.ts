/**
 * Optional AI Advisor. The advisor only ever sees a minimal, local context for a
 * single decision and can only choose among candidates produced locally.
 * Local safety checks run again after its answer; it never has the final say.
 */
export interface NamingAdviceRequest {
  file: string;
  kind: 'variable' | 'parameter';
  currentName: string;
  valueType: string;
  /** Truncated initializer / usage summary, never the whole file. */
  context?: string;
  enclosingFunction?: string;
  candidates: { name: string; score: number; evidence: string[] }[];
  /** Top project vocabulary words. */
  vocabulary: string[];
}

export interface NamingAdvice {
  /** One of the candidate names, or null when none is clearly right. */
  choice: string | null;
  rationale?: string;
}

export interface AIAdvisor {
  id: string;
  adviseName(req: NamingAdviceRequest): Promise<NamingAdvice | null>;
}

/** Parses an advisor reply defensively and enforces "choose among candidates". */
export function parseAdvice(text: string, allowed: string[]): NamingAdvice | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]) as { choice?: unknown; rationale?: unknown };
    const rationale = typeof obj.rationale === 'string' ? obj.rationale.slice(0, 200) : undefined;
    if (obj.choice === null) return { choice: null, rationale };
    if (typeof obj.choice === 'string' && allowed.includes(obj.choice)) return { choice: obj.choice, rationale };
  } catch {
    /* fallthrough */
  }
  return null;
}
