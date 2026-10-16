import { Buffer } from 'buffer';

// Minimal `process` for dependencies that probe it (Babel, PostCSS ...). `versions.node` is deliberately absent.
export const process = {
  env: {} as Record<string, string | undefined>,
  platform: 'browser',
  versions: {} as Record<string, string>,
  browser: true,
  argv: [] as string[],
  cwd: () => '/',
  nextTick: (fn: (...a: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => fn(...args)),
  emitWarning: () => undefined,
};
export { Buffer };
