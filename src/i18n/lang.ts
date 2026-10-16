export type Lang = 'en' | 'ja';

type Env = Record<string, string | undefined>;

/** Resolves `auto` from the environment (LANG / LC_ALL) or the browser's language. */
export function resolveLanguage(setting: 'auto' | 'en' | 'ja' | undefined, env?: Env): Lang {
  if (setting === 'en' || setting === 'ja') return setting;
  const nav = (globalThis as { navigator?: { language?: string } }).navigator?.language;
  const e: Env = env ?? (globalThis as { process?: { env?: Env } }).process?.env ?? {};
  const raw = nav ?? e.CODEREFINER_LANG ?? e.LC_ALL ?? e.LC_MESSAGES ?? e.LANG ?? '';
  return /^ja/i.test(raw) ? 'ja' : 'en';
}
