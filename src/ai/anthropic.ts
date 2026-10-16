import type { Config } from '../core/config.js';
import { parseAdvice, type AIAdvisor, type NamingAdviceRequest, type NamingAdvice } from './advisor.js';

/** AI Advisor backed by the Anthropic Messages API. Requires an API key in the environment. */
export class AnthropicAdvisor implements AIAdvisor {
  id = 'anthropic';
  private calls = 0;

  constructor(
    private readonly cfg: Config['ai'],
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly maxCalls = 200,
  ) {}

  async adviseName(req: NamingAdviceRequest): Promise<NamingAdvice | null> {
    if (this.calls++ >= this.maxCalls) return null;
    const prompt = [
      'You help rename a poorly named identifier in source code.',
      'Choose exactly one of the candidate names, or null if none is clearly right.',
      'Reply with JSON only: {"choice": "<candidate or null>", "rationale": "<short reason>"}.',
      '',
      JSON.stringify(
        {
          currentName: req.currentName,
          kind: req.kind,
          valueType: req.valueType,
          enclosingFunction: req.enclosingFunction,
          context: req.context,
          candidates: req.candidates.map((c) => ({ name: c.name, score: c.score })),
          projectVocabulary: req.vocabulary,
        },
        null,
        2,
      ),
    ].join('\n');

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.cfg.baseUrl.replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.cfg.model,
          max_tokens: 200,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { content?: { type: string; text?: string }[] };
      const text = body.content?.find((c) => c.type === 'text')?.text ?? '';
      return parseAdvice(text, req.candidates.map((c) => c.name));
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createAdvisor(cfg: Config, env: NodeJS.ProcessEnv = process.env): { advisor?: AIAdvisor; warning?: string } {
  if (!cfg.aiAdvisor) return {};
  const key = env[cfg.ai.apiKeyEnv];
  if (!key) {
    return { warning: `AI Advisor is enabled but ${cfg.ai.apiKeyEnv} is not set; continuing with local analysis only.` };
  }
  return { advisor: new AnthropicAdvisor(cfg.ai, key) };
}
