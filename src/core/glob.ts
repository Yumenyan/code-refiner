/** Minimal glob matcher: `*`, `**`, `?`. Patterns without `/` match any path segment. */
export function globToRegExp(pattern: string): RegExp {
  let p = pattern.replace(/\\/g, '/');
  const anchored = p.includes('/');
  p = p.replace(/^\.\//, '').replace(/\/$/, '');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '*') {
      if (p[i + 1] === '*') {
        i++;
        if (p[i + 1] === '/') i++;
        re += '(?:.*/)?';
        // `**` at the end matches everything below
        if (i === p.length - 1) re += '.*';
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  // Unanchored patterns match a segment anywhere, plus anything beneath it.
  return anchored ? new RegExp(`^${re}(?:/.*)?$`) : new RegExp(`(?:^|/)${re}(?:/.*)?$`);
}

export function matchesAny(path: string, regs: RegExp[]): boolean {
  return regs.some((r) => r.test(path));
}
