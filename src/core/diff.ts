export type DiffOp = { type: 'equal' | 'add' | 'del'; line: string };

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  ops: DiffOp[];
}

export interface LineDiff {
  added: number;
  removed: number;
  hunks: Hunk[];
}

export interface FileDiff {
  path: string;
  status: 'added' | 'removed' | 'modified' | 'unchanged';
  added: number;
  removed: number;
  hunks: Hunk[];
}

/** Myers O(ND) diff over lines. */
export function diffLines(a: string[], b: string[]): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const prefix: DiffOp[] = a.slice(0, start).map((line) => ({ type: 'equal', line }));
  const suffix: DiffOp[] = a.slice(endA).map((line) => ({ type: 'equal', line }));
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  return [...prefix, ...myers(x, y), ...suffix];
}

function myers(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((line) => ({ type: 'add', line }));
  if (m === 0) return a.map((line) => ({ type: 'del', line }));
  const max = n + m;
  // Guard: very large edit scripts fall back to a coarse replacement.
  if (max > 20000) return [...a.map((line) => ({ type: 'del' as const, line })), ...b.map((line) => ({ type: 'add' as const, line }))];
  const trace: Int32Array[] = [];
  let v = new Int32Array(2 * max + 2);
  const off = max;
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let xx: number;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) xx = v[off + k + 1];
      else xx = v[off + k - 1] + 1;
      let yy = xx - k;
      while (xx < n && yy < m && a[xx] === b[yy]) {
        xx++;
        yy++;
      }
      next[off + k] = xx;
      if (xx >= n && yy >= m) {
        found = true;
        break;
      }
    }
    v = next;
  }
  // backtrack
  const ops: DiffOp[] = [];
  let xx = n;
  let yy = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const vv = trace[d];
    const k = xx - yy;
    let prevK: number;
    if (k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vv[off + prevK];
    const prevY = prevX - prevK;
    while (xx > prevX && yy > prevY) {
      ops.push({ type: 'equal', line: a[xx - 1] });
      xx--;
      yy--;
    }
    if (xx === prevX) {
      ops.push({ type: 'add', line: b[yy - 1] });
      yy--;
    } else {
      ops.push({ type: 'del', line: a[xx - 1] });
      xx--;
    }
  }
  while (xx > 0 && yy > 0) {
    ops.push({ type: 'equal', line: a[xx - 1] });
    xx--;
    yy--;
  }
  return ops.reverse();
}

export function toHunks(ops: DiffOp[], context = 3): Hunk[] {
  const hunks: Hunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type === 'equal') {
      oldLine++;
      newLine++;
      i++;
      continue;
    }
    // start hunk with leading context
    const begin = Math.max(0, i - context);
    const lead = i - begin;
    let j = i;
    let lastChange = i;
    while (j < ops.length) {
      if (ops[j].type !== 'equal') lastChange = j;
      else if (j - lastChange > context * 2) break;
      j++;
    }
    const endIdx = Math.min(ops.length, lastChange + 1 + context);
    const slice = ops.slice(begin, endIdx);
    const oldStart = oldLine - lead;
    const newStart = newLine - lead;
    const oldLines = slice.filter((o) => o.type !== 'add').length;
    const newLines = slice.filter((o) => o.type !== 'del').length;
    hunks.push({ oldStart, oldLines, newStart, newLines, ops: slice });
    for (let k = i; k < endIdx; k++) {
      if (ops[k].type !== 'add') oldLine++;
      if (ops[k].type !== 'del') newLine++;
    }
    i = endIdx;
  }
  return hunks;
}

export function diffText(before: string, after: string): LineDiff {
  const a = before.split('\n');
  const b = after.split('\n');
  const ops = diffLines(a, b);
  return {
    added: ops.filter((o) => o.type === 'add').length,
    removed: ops.filter((o) => o.type === 'del').length,
    hunks: toHunks(ops),
  };
}

export function diffFile(path: string, before: string | undefined, after: string | undefined): FileDiff {
  if (before === undefined && after !== undefined) {
    return { path, status: 'added', added: after.split('\n').length, removed: 0, hunks: [] };
  }
  if (before !== undefined && after === undefined) {
    return { path, status: 'removed', added: 0, removed: before.split('\n').length, hunks: [] };
  }
  if (before === after) return { path, status: 'unchanged', added: 0, removed: 0, hunks: [] };
  const d = diffText(before ?? '', after ?? '');
  return { path, status: 'modified', ...d };
}

export function unifiedDiff(d: FileDiff): string {
  if (d.status === 'unchanged' || d.hunks.length === 0) return '';
  const out = [`--- a/${d.path}`, `+++ b/${d.path}`];
  for (const h of d.hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    for (const op of h.ops) out.push((op.type === 'add' ? '+' : op.type === 'del' ? '-' : ' ') + op.line);
  }
  return out.join('\n') + '\n';
}
