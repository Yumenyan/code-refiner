// Replaces Node-only / very large dependencies in the browser bundle (Prettier's Node entry, the TypeScript compiler).
const stub: Record<string, unknown> = new Proxy({}, { get: () => () => { throw new Error('Not available in the browser build'); } });
export default stub;
export const format = () => { throw new Error('Not available in the browser build'); };
