import { usageAmountToTokens } from './curTokenUnits';

describe('usageAmountToTokens', () => {
  it('converts "1K tokens" usage amounts to absolute tokens', () => {
    expect(usageAmountToTokens(46.361, '1K tokens')).toBeCloseTo(46361, 6);
    expect(usageAmountToTokens(0.176, '1K tokens')).toBeCloseTo(176, 6);
  });

  it('converts "1M tokens" usage amounts', () => {
    expect(usageAmountToTokens(2.5, '1M tokens')).toBe(2_500_000);
  });

  it('is case/whitespace tolerant', () => {
    expect(usageAmountToTokens(2, ' 1k Tokens ')).toBe(2000);
  });

  it('leaves unknown or missing units unchanged', () => {
    expect(usageAmountToTokens(7, 'Requests')).toBe(7);
    expect(usageAmountToTokens(7, undefined)).toBe(7);
  });

  it('returns 0 for non-finite amounts', () => {
    expect(usageAmountToTokens(NaN, '1K tokens')).toBe(0);
  });
});
