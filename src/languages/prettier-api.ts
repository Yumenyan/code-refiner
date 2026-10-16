/**
 * Indirection over Prettier so the same Language Packs run in Node (full `prettier`)
 * and in the browser (`prettier/standalone` + explicitly bundled plugins).
 */
export interface PrettierLike {
  format(source: string, options: Record<string, unknown>): Promise<string>;
}

let configured: PrettierLike | null = null;
let loading: Promise<PrettierLike> | null = null;

/** Browser / custom builds call this once at startup. */
export function configurePrettier(api: PrettierLike): void {
  configured = api;
}

export function getPrettier(): Promise<PrettierLike> {
  if (configured) return Promise.resolve(configured);
  loading ??= import('prettier').then((m) => (configured = m as unknown as PrettierLike));
  return loading;
}
