import { posixJoin } from './text.js';
import { NON_CODE_LANGUAGES } from './detect.js';
import type { Project, ProjectMetadata, Runtime, ValidationCommand } from './types.js';

const FRAMEWORK_DEPS: Record<string, string> = {
  react: 'react', 'react-dom': 'react', next: 'next', vue: 'vue', nuxt: 'nuxt', svelte: 'svelte', '@sveltejs/kit': 'sveltekit',
  '@angular/core': 'angular', preact: 'preact', solid: 'solid', 'solid-js': 'solid', jquery: 'jquery', three: 'three',
  express: 'express', fastify: 'fastify', koa: 'koa', electron: 'electron', 'react-native': 'react-native', astro: 'astro',
  lit: 'lit', alpinejs: 'alpine', htmx: 'htmx', 'chart.js': 'chart.js', d3: 'd3', phaser: 'phaser', leaflet: 'leaflet', tailwindcss: 'tailwind', bootstrap: 'bootstrap',
};
const BUILD_TOOL_DEPS: Record<string, string> = {
  vite: 'vite', webpack: 'webpack', rollup: 'rollup', parcel: 'parcel', esbuild: 'esbuild', tsup: 'tsup', turbo: 'turbo', gulp: 'gulp', grunt: 'grunt',
};
const TEST_DEPS: Record<string, string> = { vitest: 'vitest', jest: 'jest', mocha: 'mocha', ava: 'ava', playwright: 'playwright', '@playwright/test': 'playwright', cypress: 'cypress' };
const NODE_DEPS = new Set(['express', 'fastify', 'koa', 'commander', 'yargs', 'dotenv', 'mongoose', 'pg', 'electron']);

function parseJson<T>(text: string | undefined): T | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

interface PackageJson {
  name?: string;
  main?: string;
  module?: string;
  browser?: string | Record<string, string>;
  bin?: string | Record<string, string>;
  type?: string;
  exports?: unknown;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
}

export function detectMetadata(project: Project, textOf: (path: string) => string | undefined, supported: Set<string>): ProjectMetadata {
  const paths = new Set(project.files.filter((f) => !f.omitted).map((f) => f.path));
  const has = (p: string) => paths.has(p);
  const rootFiles = [...paths].filter((p) => !p.includes('/'));

  const pkg = parseJson<PackageJson>(textOf('package.json'));
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const frameworks = new Set<string>();
  const buildTools = new Set<string>();
  const testRunners = new Set<string>();
  for (const d of Object.keys(deps)) {
    if (FRAMEWORK_DEPS[d]) frameworks.add(FRAMEWORK_DEPS[d]);
    if (BUILD_TOOL_DEPS[d]) buildTools.add(BUILD_TOOL_DEPS[d]);
    if (TEST_DEPS[d]) testRunners.add(TEST_DEPS[d]);
  }
  for (const f of rootFiles) {
    const m = f.match(/^(vite|webpack|rollup|parcel|esbuild|gulpfile|next|nuxt|svelte|astro)\.config\./) ?? f.match(/^(gulpfile)\./);
    if (m) {
      const name = m[1] === 'gulpfile' ? 'gulp' : m[1];
      if (['next', 'nuxt', 'svelte', 'astro'].includes(name)) frameworks.add(name === 'svelte' ? 'svelte' : name);
      else buildTools.add(name);
    }
    if (/^(vitest|jest)\.config\./.test(f)) testRunners.add(f.split('.')[0]);
  }

  // language census (code languages only)
  const counts = new Map<string, number>();
  const unsupported = new Map<string, number>();
  for (const f of project.files) {
    if (f.omitted || f.ignored || f.kind === 'binary' || !f.language) continue;
    if (NON_CODE_LANGUAGES.has(f.language)) continue;
    if (supported.has(f.language)) {
      if (f.language !== 'json') counts.set(f.language, (counts.get(f.language) ?? 0) + 1);
    } else unsupported.set(f.language, (unsupported.get(f.language) ?? 0) + 1);
  }
  const languages = [...counts.entries(), ...unsupported.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);
  const typescript = counts.has('typescript') || has('tsconfig.json');

  const entry = new Set<string>();
  const addEntry = (p?: string) => {
    if (!p) return;
    const n = posixJoin(p);
    if (paths.has(n)) entry.add(n);
    else for (const ext of ['.js', '.mjs', '.ts', '.cjs']) if (paths.has(n + ext)) entry.add(n + ext);
  };
  addEntry(pkg?.main);
  addEntry(pkg?.module);
  if (typeof pkg?.browser === 'string') addEntry(pkg.browser);
  if (typeof pkg?.bin === 'string') addEntry(pkg.bin);
  else if (pkg?.bin) Object.values(pkg.bin).forEach(addEntry);
  if (typeof pkg?.exports === 'string') addEntry(pkg.exports);
  for (const guess of ['index.html', 'public/index.html', 'src/index.html', 'src/main.ts', 'src/main.tsx', 'src/main.js', 'src/main.jsx', 'src/index.ts', 'src/index.tsx', 'src/index.js', 'src/index.jsx', 'main.js', 'main.ts', 'index.js', 'index.ts', 'app.js', 'server.js']) {
    if (paths.has(guess)) entry.add(guess);
  }

  const htmlPresent = counts.has('html');
  const nodeish = Object.keys(deps).some((d) => NODE_DEPS.has(d)) || !!pkg?.bin || !!pkg?.engines?.node || frameworks.has('express');
  let runtime: Runtime = 'unknown';
  if (htmlPresent || frameworks.has('react') || frameworks.has('vue') || frameworks.has('svelte') || buildTools.has('vite')) runtime = nodeish ? 'universal' : 'browser';
  else if (nodeish || pkg) runtime = 'node';

  const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') ? 'bun' : pkg ? 'npm' : undefined;
  const cmds: ValidationCommand[] = [];
  if (pkg?.scripts) {
    const run = (s: string) => (pm === 'npm' ? (s === 'test' ? 'npm test' : `npm run ${s}`) : `${pm} ${s === 'test' ? 'test' : 'run ' + s}`);
    const sc = pkg.scripts;
    for (const name of ['typecheck', 'type-check', 'check-types', 'tsc']) if (sc[name]) { cmds.push({ kind: 'typecheck', command: run(name), source: `package.json scripts.${name}` }); break; }
    if (sc.build) cmds.push({ kind: 'build', command: run('build'), source: 'package.json scripts.build' });
    if (sc.test && !/no test specified/.test(sc.test)) cmds.push({ kind: 'test', command: run('test'), source: 'package.json scripts.test' });
    if (sc.lint) cmds.push({ kind: 'lint', command: run('lint'), source: 'package.json scripts.lint' });
  }
  if (has('Cargo.toml')) {
    cmds.push({ kind: 'build', command: 'cargo build', source: 'Cargo.toml' }, { kind: 'test', command: 'cargo test', source: 'Cargo.toml' });
  }

  return {
    name: pkg?.name ?? project.name,
    runtime,
    languages,
    frameworks: [...frameworks].sort(),
    entryPoints: [...entry].sort(),
    packageManager: pm,
    scripts: pkg?.scripts ?? {},
    typescript,
    tsconfig: has('tsconfig.json') ? 'tsconfig.json' : undefined,
    buildTools: [...buildTools].sort(),
    testRunners: [...testRunners].sort(),
    validationCommands: cmds,
    unsupportedLanguages: [...unsupported.keys()].sort(),
  };
}

