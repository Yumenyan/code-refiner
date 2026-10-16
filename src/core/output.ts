/** Node-only file output helpers (dynamic imports keep the browser bundle free of Node built-ins). */

/** Writes files below `root`, refusing any path that would escape it. */
export async function writeFiles(root: string, files: { path: string; data: Uint8Array }[]): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { dirname, resolve, sep } = await import('node:path');
  const base = resolve(root);
  for (const f of files) {
    const target = resolve(base, f.path);
    if (target !== base && !target.startsWith(base + sep)) throw new Error(`Refusing to write outside output: ${f.path}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, f.data);
  }
}

export async function resetDir(dir: string): Promise<void> {
  const { mkdir, rm } = await import('node:fs/promises');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
}
