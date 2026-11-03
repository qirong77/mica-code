import { describe, expect, it } from 'vitest';
import { qrModules, qrPath } from './components/QrCode.js';

/** path 里每条横条覆盖多少个模块：与矩阵里深色格的数量必须一致。 */
function coveredModules(path: string): number {
  return [...path.matchAll(/h(\d+)v1H\d+z/g)].reduce((sum, match) => sum + Number(match[1]), 0);
}

describe('qrModules', () => {
  it('encodes to a square matrix with a finder pattern in the top-left corner', () => {
    const modules = qrModules('https://mica.example.com/?t=0123456789abcdef');
    expect(modules.length).toBeGreaterThanOrEqual(21);
    for (const row of modules) expect(row).toHaveLength(modules.length);
    // 左上角定位图案：第一行前 7 格全黑
    expect(modules[0]?.slice(0, 7)).toEqual([true, true, true, true, true, true, true]);
    expect(modules[1]?.[0]).toBe(true);
  });

  it('is deterministic and grows with the payload', () => {
    const short = qrModules('a');
    expect(qrModules('a')).toEqual(short);
    const long = qrModules(`https://mica.example.com/?t=${'x'.repeat(200)}`);
    expect(long.length).toBeGreaterThan(short.length);
    expect(long).not.toEqual(short);
  });
});

describe('qrPath', () => {
  it('covers exactly the dark modules, once each', () => {
    const modules = qrModules('https://mica.example.com/?t=0123456789abcdef');
    const dark = modules.flat().filter(Boolean).length;
    expect(coveredModules(qrPath(modules))).toBe(dark);
  });

  it('starts from the top-left finder pattern', () => {
    const path = qrPath(qrModules('https://mica.example.com'));
    expect(path.startsWith('M0 0h7v1H0z')).toBe(true);
  });

  it('draws nothing for an empty matrix', () => {
    expect(qrPath([])).toBe('');
  });
});
