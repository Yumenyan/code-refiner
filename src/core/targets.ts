import type { Config } from './config.js';

/**
 * Language level a project must stay within. For ECMAScript the number is the edition year
 * (3, 5, 2015 ... 2024); `rhino` is the conservative profile for the Rhino engine (ES5 syntax, no
 * trailing commas, no ES2015 conveniences).
 */
const ECMA: Record<string, number> = {
  es3: 3, ecmascript3: 3, es5: 5, ecmascript5: 5, rhino: 5, 'rhino-es3': 3,
  es6: 2015, es2015: 2015, es2016: 2016, es2017: 2017, es2018: 2018, es2019: 2019, es2020: 2020,
  es2021: 2021, es2022: 2022, es2023: 2023, es2024: 2024, latest: 9999, esnext: 9999,
};

export const ECMA_TARGETS = ['es3', 'es5', 'rhino', 'es2015', 'es2016', 'es2017', 'es2018', 'es2019', 'es2020', 'es2021', 'es2022', 'latest'];

export function parseEcmaTarget(name: string | undefined): number {
  if (!name) return 9999;
  const n = ECMA[name.toLowerCase().replace(/[\s_-]/g, '').replace(/^rhinoes3$/, 'rhino-es3')] ?? ECMA[name.toLowerCase()];
  if (n === undefined) throw new Error(`Unknown ECMAScript target "${name}" (${ECMA_TARGETS.join(' | ')})`);
  return n;
}

/** Target of a language, falling back from `typescript` to `javascript`-style names and finally to "latest". */
export function targetFor(config: Config, language: string): string | undefined {
  return config.target[language];
}

export function ecmaLevel(config: Config, language: string): number {
  return parseEcmaTarget(config.target[language] ?? (language === 'typescript' ? undefined : config.target.javascript));
}

export const isRhino = (config: Config, language: string) => (config.target[language] ?? '').toLowerCase().startsWith('rhino');

/** Newer syntax -> the edition that introduced it (used to warn about code above the target). */
export const SYNTAX_SINCE: Record<string, [number, string]> = {
  ArrowFunctionExpression: [2015, 'arrow function'],
  TemplateLiteral: [2015, 'template literal'],
  ClassDeclaration: [2015, 'class'],
  ClassExpression: [2015, 'class'],
  ForOfStatement: [2015, 'for…of'],
  SpreadElement: [2015, 'spread'],
  RestElement: [2015, 'rest parameter / pattern'],
  ObjectPattern: [2015, 'destructuring'],
  ArrayPattern: [2015, 'destructuring'],
  AssignmentPattern: [2015, 'default value'],
  ImportDeclaration: [2015, 'import'],
  ExportNamedDeclaration: [2015, 'export'],
  ExportDefaultDeclaration: [2015, 'export'],
  TaggedTemplateExpression: [2015, 'tagged template'],
  YieldExpression: [2015, 'generator'],
  AwaitExpression: [2017, 'async / await'],
  OptionalMemberExpression: [2020, 'optional chaining'],
  OptionalCallExpression: [2020, 'optional chaining'],
  BigIntLiteral: [2020, 'BigInt'],
  ClassProperty: [2022, 'class field'],
  ClassPrivateProperty: [2022, 'private class field'],
  StaticBlock: [2022, 'static block'],
};
