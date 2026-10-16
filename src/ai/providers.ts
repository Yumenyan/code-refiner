import type { Config } from '../core/config.js';

export type AiProvider = 'anthropic' | 'openai' | 'gemini' | 'local';

export interface ResolvedAi {
  provider: AiProvider;
  model: string;
  baseUrl: string;
  /** Environment variables tried (in order) for the API key. */
  keyEnv: string[];
  keyRequired: boolean;
  timeoutMs: number;
}

const DEFAULTS: Record<AiProvider, { model: string; baseUrl: string; keyEnv: string[]; keyRequired: boolean }> = {
  anthropic: { model: 'claude-haiku-5-5', baseUrl: 'https://api.anthropic.com', keyEnv: ['ANTHROPIC_API_KEY'], keyRequired: true },
  openai: { model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', keyEnv: ['OPENAI_API_KEY'], keyRequired: true },
  gemini: { model: 'gemini-2.0-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], keyRequired: true },
  // Any OpenAI-compatible server: Ollama, LM Studio, llama.cpp server, vLLM ...
  local: { model: 'llama3.2', baseUrl: 'http://localhost:11434/v1', keyEnv: ['LOCAL_LLM_API_KEY'], keyRequired: false },
};

export function resolveAi(ai: Config['ai']): ResolvedAi {
  const d = DEFAULTS[ai.provider];
  if (!d) throw new Error(`Unknown AI provider "${ai.provider}" (anthropic | openai | gemini | local)`);
  return {
    provider: ai.provider,
    model: ai.model || d.model,
    baseUrl: (ai.baseUrl || d.baseUrl).replace(/\/$/, ''),
    keyEnv: ai.apiKeyEnv ? [ai.apiKeyEnv] : d.keyEnv,
    keyRequired: d.keyRequired,
    timeoutMs: ai.timeoutMs,
  };
}

export const AI_PROVIDERS: AiProvider[] = ['anthropic', 'openai', 'gemini', 'local'];
export const aiDefaults = (p: AiProvider) => DEFAULTS[p];

export interface ChatRequest {
  system: string;
  user: string;
  maxTokens: number;
}
export type ChatFn = (req: ChatRequest) => Promise<string | null>;

/** One thin chat function per provider. Each returns the model's text, or null on any failure. */
export function makeChat(ai: ResolvedAi, apiKey: string | undefined, fetchImpl: typeof fetch = fetch, opts: { browser?: boolean } = {}): ChatFn {
  return async ({ system, user, maxTokens }) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ai.timeoutMs);
    try {
      let url: string;
      let headers: Record<string, string> = { 'content-type': 'application/json' };
      let body: unknown;
      switch (ai.provider) {
        case 'anthropic':
          url = `${ai.baseUrl}/v1/messages`;
          headers = { ...headers, 'x-api-key': apiKey ?? '', 'anthropic-version': '2023-06-01', ...(opts.browser ? { 'anthropic-dangerous-direct-browser-access': 'true' } : {}) };
          body = { model: ai.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] };
          break;
        case 'openai':
        case 'local':
          url = `${ai.baseUrl}/chat/completions`;
          if (apiKey) headers.authorization = `Bearer ${apiKey}`;
          body = {
            model: ai.model,
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
            ...(ai.provider === 'openai' ? { max_completion_tokens: maxTokens, response_format: { type: 'json_object' } } : { max_tokens: maxTokens, temperature: 0 }),
          };
          break;
        case 'gemini':
          url = `${ai.baseUrl}/models/${encodeURIComponent(ai.model)}:generateContent`;
          headers['x-goog-api-key'] = apiKey ?? '';
          body = {
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: user }] }],
            generationConfig: { temperature: 0, maxOutputTokens: maxTokens, responseMimeType: 'application/json' },
          };
          break;
      }
      const res = await fetchImpl(url, { method: 'POST', signal: ctrl.signal, headers, body: JSON.stringify(body) });
      if (!res.ok) return null;
      const json = (await res.json()) as Record<string, unknown>;
      return extractText(ai.provider, json);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

function extractText(provider: AiProvider, json: Record<string, unknown>): string | null {
  if (provider === 'anthropic') {
    const content = json.content as { type: string; text?: string }[] | undefined;
    return content?.find((c) => c.type === 'text')?.text ?? null;
  }
  if (provider === 'gemini') {
    const cands = json.candidates as { content?: { parts?: { text?: string }[] } }[] | undefined;
    return cands?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? null;
  }
  const choices = json.choices as { message?: { content?: string } }[] | undefined;
  return choices?.[0]?.message?.content ?? null;
}
