import { describe, expect, it } from 'vitest';
import { fmtDist, fmtTime } from './format';

describe('display formats', () => {
  it('carries rounded seconds into the minute instead of printing :60', () => {
    expect(fmtTime(3119.6)).toBe('52:00 min');
    expect(fmtTime(59.5)).toBe('1:00 min');
    expect(fmtTime(614)).toBe('10:14 min');
    expect(fmtTime(3599.6)).toBe('1 h 0 min');
    expect(fmtTime(4560)).toBe('1 h 16 min');
    expect(fmtTime(Infinity)).toBe('–');
  });

  it('prints metres below a kilometre and kilometres to two decimals above', () => {
    expect(fmtDist(999.4)).toBe('999 m');
    expect(fmtDist(4450)).toBe('4.45 km');
    expect(fmtDist(NaN)).toBe('–');
  });
});
