import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { resolveConfig, type Config } from '../core/config.js';
import { scanZipBuffer } from '../core/scanner.js';
import { refineProject } from '../pipeline.js';
import { writeOutputs } from '../node.js';
import { UI_HTML } from './page.js';

export interface UiOptions {
  port?: number;
  host?: string;
  outRoot: string;
  baseConfig?: Partial<Config>;
  maxUploadBytes?: number;
}

const MAX_UPLOAD = 512 * 1024 * 1024;

function send(res: ServerResponse, status: number, body: string | object, type = 'application/json; charset=utf-8'): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(text);
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw Object.assign(new Error('Upload too large'), { status: 413 });
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

function openFolder(dir: string): void {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [dir]] : process.platform === 'win32' ? ['explorer', [dir]] : ['xdg-open', [dir]];
  const child = spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore' });
  child.on('error', () => undefined);
  child.unref();
}

/** Starts the local web UI. Binds to loopback only and requires a custom header on every POST. */
export async function startUi(opts: UiOptions): Promise<{ server: Server; url: string; close(): Promise<void> }> {
  const host = opts.host ?? '127.0.0.1';
  const outRoot = resolve(opts.outRoot);
  await mkdir(outRoot, { recursive: true });
  const runs = new Map<string, { dir: string }>();
  let counter = 0;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const hostHeader = (req.headers.host ?? '').split(':')[0];
      if (!['localhost', '127.0.0.1', '[::1]', host].includes(hostHeader)) return send(res, 403, { error: 'Forbidden host' });

      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, UI_HTML, 'text/html; charset=utf-8');

      if (req.method === 'GET' && url.pathname.startsWith('/out/')) {
        const [, , id, file] = url.pathname.split('/');
        const run = runs.get(id);
        if (!run || !['report.html', 'report.json', 'refined-project.zip', 'changes.diff'].includes(file ?? '')) return send(res, 404, { error: 'Not found' });
        const full = join(run.dir, file);
        const st = await stat(full).catch(() => null);
        if (!st) return send(res, 404, { error: 'Not found' });
        const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.zip') ? 'application/zip' : 'text/plain; charset=utf-8';
        res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", ...(file.endsWith('.zip') ? { 'content-disposition': 'attachment; filename="refined-project.zip"' } : {}) });
        createReadStream(full).pipe(res);
        return;
      }

      if (req.method === 'POST') {
        if (req.headers['x-coderefiner'] !== '1') return send(res, 403, { error: 'Missing X-CodeRefiner header' });

        if (url.pathname === '/api/refine') {
          const body = await readBody(req, opts.maxUploadBytes ?? MAX_UPLOAD);
          const mode = url.searchParams.get('mode') ?? 'safe';
          const name = (url.searchParams.get('name') || 'project').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'project';
          const config = resolveConfig({ ...opts.baseConfig, mode, aiAdvisor: url.searchParams.get('ai') === '1' || opts.baseConfig?.aiAdvisor });
          const project = scanZipBuffer(body, name, config);
          const result = await refineProject(project, config);
          const id = `${Date.now().toString(36)}${(counter++).toString(36)}`;
          const dir = join(outRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}`);
          await writeOutputs(result, dir);
          runs.set(id, { dir });
          const aiNote = config.aiAdvisor && !result.aiUsed ? 'AI Advisor was requested but no API key is configured; local analysis only.' : '';
          return send(res, 200, { id, files: result.stats.totalFiles, changed: result.stats.changedFiles, warnings: result.stats.warnings, refinedDir: join(dir, 'refined'), aiNote });
        }
        if (url.pathname === '/api/open') {
          const run = runs.get(url.searchParams.get('id') ?? '');
          if (!run) return send(res, 404, { error: 'Unknown run' });
          openFolder(join(run.dir, 'refined'));
          return send(res, 200, { ok: true });
        }
      }
      send(res, 404, { error: 'Not found' });
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      send(res, status, { error: (e as Error).message });
    }
  });

  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(opts.port ?? 4173, host, ok);
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  return {
    server,
    url: `http://${host}:${port}/`,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

