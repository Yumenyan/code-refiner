import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';
import { decodeBytes } from '../src/core/encoding.js';
import { run, text } from './helpers/util.js';

describe('Text encodings (Japanese projects)', () => {
  const js = '// 駅の一覧\nfunction f(a){ if (a > 1) { return true; } else { return false; } }\nconst 駅名 = "東京";\n';

  it('round-trips Shift_JIS files and keeps their encoding', async () => {
    const sjis = iconv.encode(js, 'cp932');
    const r = await run({ 'a.js': sjis });
    const out = r.refined.get('a.js')!;
    const back = iconv.decode(out, 'cp932');
    expect(back).toContain('// 駅の一覧');
    expect(back).toContain('return a > 1');
    expect(back).toContain('const 駅名 = "東京"');
    expect(decodeBytes(out)?.encoding).toBe('cp932');
  });

  it('round-trips EUC-JP and UTF-16 (BOM)', async () => {
    const euc = iconv.encode(js, 'euc-jp');
    expect(iconv.decode((await run({ 'a.js': euc })).refined.get('a.js')!, 'euc-jp')).toContain('return a > 1');
    const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(js, 'utf-16le')]);
    const out = (await run({ 'a.js': u16 })).refined.get('a.js')!;
    expect(out.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect(iconv.decode(out.subarray(2), 'utf-16le')).toContain('return a > 1');
  });

  it('copies undecodable files untouched instead of corrupting them', async () => {
    const weird = Buffer.from([0x66, 0x6f, 0x6f, 0x80, 0x81, 0xfe, 0xff, 0x0a]);
    const r = await run({ 'a.js': weird });
    expect(r.refined.get('a.js')).toEqual(weird);
    expect(r.files[0].status).toBe('ignored');
  });

  it('UTF-8 Japanese text is preserved', async () => {
    const r = await run({ 'a.js': js, 'a.html': '<p>こんにちは</p>', 'a.md': '# 見出し\n\n*  項目\n' });
    expect(text(r, 'a.js')).toContain('// 駅の一覧');
    expect(text(r, 'a.html')).toContain('こんにちは');
    expect(text(r, 'a.md')).toContain('- 項目');
  });
});
