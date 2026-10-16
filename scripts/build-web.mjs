// Builds the static browser version into ./site (deployable to GitHub Pages or any static host).
import { build } from 'esbuild';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'site');
const require = createRequire(import.meta.url);
const stub = join(root, 'src/web/stub.ts');

await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'wasm'), { recursive: true });

await build({
  entryPoints: { worker: join(root, 'src/web/worker.ts'), main: join(root, 'src/web/main.ts') },
  outdir: out,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  inject: [join(root, 'src/web/buffer-shim.ts')],
  // Bare `fs` / `path` are NOT external: packages like postcss map them to empty modules through their `browser` field.
  external: ['node:*'],
  plugins: [
    {
      // Exact-match stubs: `prettier/standalone` etc. must still resolve normally.
      name: 'browser-stubs',
      setup(b) {
        b.onResolve({ filter: /^(prettier|typescript)$/ }, () => ({ path: stub }));
        // Node-only branches of recast / web-tree-sitter are never executed in a browser.
        b.onResolve({ filter: /^(os|fs|path)$/ }, (args) =>
          /node_modules[\\/](recast|web-tree-sitter)[\\/]/.test(args.importer) ? { path: args.path, namespace: 'node-stub' } : undefined,
        );
        b.onLoad({ filter: /.*/, namespace: 'node-stub' }, (args) => ({ contents: args.path === 'os' ? 'module.exports = { EOL: "\\n" };' : 'module.exports = {};', loader: 'js' }));
      },
    },
  ],
  define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
});

// The page markup is shared with the local UI: bundle it once, then render the static HTML.
const markup = await build({ entryPoints: [join(root, 'src/ui/markup.ts')], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent' });
const { renderPageHtml } = await import(`data:text/javascript;base64,${Buffer.from(markup.outputFiles[0].text).toString('base64')}`);
await writeFile(join(out, 'index.html'), renderPageHtml('web', '<script type="module" src="main.js"></script>'));
await writeFile(join(out, '.nojekyll'), '');

const wasmDir = join(dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');
const langs = ['java', 'c_sharp', 'go', 'python', 'rust', 'ruby', 'php', 'kotlin', 'swift', 'c', 'cpp', 'bash', 'scala'];
for (const l of langs) await cp(join(wasmDir, `tree-sitter-${l}.wasm`), join(out, 'wasm', `tree-sitter-${l}.wasm`));
await cp(join(dirname(require.resolve('web-tree-sitter/package.json')), 'tree-sitter.wasm'), join(out, 'wasm', 'tree-sitter.wasm'));
console.log(`Built ${out}`);
