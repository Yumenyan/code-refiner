import type { Config } from '../core/config.js';
import { parseAdvice, type AIAdvisor, type NamingAdvice, type NamingAdviceRequest } from './advisor.js';
import { makeChat, resolveAi, type ChatFn, type ResolvedAi } from './providers.js';

const SYSTEM = `You help rename a poorly named identifier in source code so that humans can maintain it.
Rules:
- Prefer one of the given candidate names. Choose null only if none is clearly right.
- If no candidate fits, you may propose ONE better name in "proposal": a valid identifier that follows the project convention and describes what the value is.
- Never rename for style alone and never invent unrelated domain terms.
Reply with JSON only: {"choice": "<candidate or null>", "proposal": "<new name or null>", "rationale": "<one short sentence>"}.`;

/** Provider-independent AI Advisor (Anthropic, OpenAI, Gemini or any OpenAI-compatible local server). */
export class LlmAdvisor implements AIAdvisor {
  readonly id: string;
  private calls = 0;

  constructor(
    private readonly chat: ChatFn,
    id: string,
    private readonly maxCalls = 200,
  ) {
    this.id = id;
  }

  async adviseName(req: NamingAdviceRequest): Promise<NamingAdvice | null> {
    if (this.calls++ >= this.maxCalls) return null;
    const lang = req.language === 'ja' ? 'Write the rationale in Japanese.' : 'Write the rationale in English.';
    const user = JSON.stringify(
      {
        currentName: req.currentName,
        kind: req.kind,
        valueType: req.valueType,
        enclosingFunction: req.enclosingFunction,
        declaration: req.context,
        usages: req.usages,
        candidates: req.candidates.map((c) => ({ name: c.name, score: c.score })),
        projectVocabulary: req.vocabulary,
        projectConvention: req.convention,
      },
      null,
      2,
    );
    const text = await this.chat({ system: `${SYSTEM}\n${lang}`, user, maxTokens: 300 });
    return text ? parseAdvice(text, req.candidates.map((c) => c.name)) : null;
  }
}

/** Kept for API compatibility: the Anthropic flavour of {@link LlmAdvisor}. */
export class AnthropicAdvisor extends LlmAdvisor {
  constructor(cfg: ResolvedAi | Config['ai'], apiKey: string, fetchImpl: typeof fetch = fetch, maxCalls = 200, extraHeaders: Record<string, string> = {}) {
    const ai = 'keyEnv' in cfg ? cfg : resolveAi({ ...cfg, provider: 'anthropic' });
    const inner = makeChat(ai, apiKey, (url, init) => fetchImpl(url, { ...init, headers: { ...(init?.headers as Record<string, string>), ...extraHeaders } }));
    super(inner, 'anthropic', maxCalls);
  }
}

export function readKey(ai: ResolvedAi, env: Record<string, string | undefined>): string | undefined {
  for (const name of ai.keyEnv) if (env[name]) return env[name];
  return undefined;
}

export interface AdvisorSetup {
  advisor?: AIAdvisor;
  warning?: string;
}

type Env = Record<string, string | undefined>;
const defaultEnv = (): Env => (globalThis as { process?: { env?: Env } }).process?.env ?? {};

export function createAdvisor(cfg: Config, env: Env = defaultEnv(), opts: { apiKey?: string; fetchImpl?: typeof fetch; browser?: boolean } = {}): AdvisorSetup {
  if (!cfg.aiAdvisor) return {};
  const ai = resolveAi(cfg.ai);
  const key = opts.apiKey ?? readKey(ai, env);
  if (!key && ai.keyRequired) {
    return { warning: `AI Advisor (${ai.provider}) is enabled but no API key was found (${ai.keyEnv.join(' / ')}); continuing with local analysis only.` };
  }
  return { advisor: new LlmAdvisor(makeChat(ai, key, opts.fetchImpl ?? fetch, { browser: opts.browser }), `${ai.provider}:${ai.model}`) };
}
