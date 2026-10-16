import { describe, expect, it } from 'vitest';
import { run, text } from './helpers/util.js';

describe('CSS pack', () => {
  it('formats and applies only safe rules in SAFE mode', async () => {
    const r = await run({ 'a.css': `.a{color:red;color:red;margin:0}\n.a{padding:1px}\n.empty{}\n@media (max-width:600px){.b{color:blue}}` });
    const css = text(r, 'a.css');
    expect(css).toMatch(/\.a \{\n {2}color: red;\n {2}margin: 0;\n {2}padding: 1px;\n\}/);
    expect(css).toContain('.empty');
    expect(css).toContain('@media (max-width: 600px)');
  });

  it('removes empty rules only in CAUTIOUS mode', async () => {
    const r = await run({ 'a.css': `.empty{}\n.k{color:red}` }, { mode: 'cautious' });
    expect(text(r, 'a.css')).not.toContain('.empty');
  });

  it('keeps a differing earlier declaration (fallback pattern) intact', async () => {
    const r = await run({ 'a.css': `.a{display:-webkit-box;display:flex;width:calc(100% - 1px);width:100%}` });
    const css = text(r, 'a.css');
    expect(css).toContain('-webkit-box');
    expect(css).toContain('calc(100% - 1px)');
  });

  it('does not merge non-adjacent rules (cascade order)', async () => {
    const r = await run({ 'a.css': `.a{color:red}\n.b{color:blue}\n.a{margin:0}` });
    expect(text(r, 'a.css').match(/\.a \{/g)).toHaveLength(2);
  });

  it('leaves invalid CSS untouched with a warning', async () => {
    const src = `.a { color: red `;
    const r = await run({ 'a.css': src });
    expect(text(r, 'a.css')).toBe(src);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe('HTML pack', () => {
  const page = `<!DOCTYPE html><html><head><title>t</title><style type="text/css">.a{color:red;color:red}</style></head><body><div id="a" class="x  y" onclick="go()">hi <b>there</b></div><script type="text/javascript">function go(){ var v = 1; if (v > 0) { return true; } else { return false; } }</script><script type="application/json">{"a":1}</script></body></html>`;

  it('refines inline <script> and <style>, drops redundant type attributes and formats', async () => {
    const r = await run({ 'index.html': page }, { mode: 'cautious' });
    const html = text(r, 'index.html');
    expect(html).not.toContain('text/javascript');
    expect(html).not.toContain('text/css');
    expect(html).toContain('return v > 0;');
    expect(html).toMatch(/\{\s*"a":\s*1\s*\}/);
    expect(html).toMatch(/color: red;\s*\}/);
    expect(html).toContain('onclick="go()"');
  });

  it('does not rename or touch globals used by inline handlers', async () => {
    const r = await run(
      { 'index.html': `<button onclick="s.run()">x</button><script>var s = {run: function(){ return 1; }}; function go(){ var x = [1].filter(a => a); return x.length; }</script>` },
      { mode: 'aggressive', renameVariables: true },
    );
    const html = text(r, 'index.html');
    expect(html).toMatch(/var s = /);
    expect(html).toContain('s.run()');
  });

  it('preserves <pre> content and inline text', async () => {
    const src = `<html><body><pre>  keep   this\n   exactly</pre><p>a <em>b</em> c</p></body></html>`;
    const r = await run({ 'a.html': src });
    // a newline directly after <pre> is dropped by HTML parsers, so the text content is unchanged
    expect(text(r, 'a.html')).toContain('  keep   this\n   exactly</pre>');
  });

  it('is stable: formatting twice gives the same result', async () => {
    const once = text(await run({ 'a.html': page }), 'a.html');
    const twice = text(await run({ 'a.html': once }), 'a.html');
    expect(twice).toBe(once);
  });
});

describe('JSON pack', () => {
  it('formats data without changing it, and keeps package.json key order', async () => {
    const r = await run({ 'data.json': `{"b":1,"a":[1,2,{"c":null}]}`, 'package.json': `{"name":"x","version":"1.0.0","scripts":{"b":"1","a":"2"}}` });
    expect(JSON.parse(text(r, 'data.json'))).toEqual({ b: 1, a: [1, 2, { c: null }] });
    expect(Object.keys(JSON.parse(text(r, 'package.json')).scripts)).toEqual(['b', 'a']);
  });
  it('accepts JSON with comments (tsconfig) and leaves broken JSON alone', async () => {
    const r = await run({ 'tsconfig.json': `{ // c\n "a": 1 }`, 'bad.json': `{ "a": ` });
    expect(text(r, 'bad.json')).toBe(`{ "a": `);
    expect(text(r, 'tsconfig.json')).toContain('// c');
  });
});
