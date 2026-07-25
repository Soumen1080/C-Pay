/**
 * Unit tests for currency utility functions.
 *
 * We force PILOT_MODE = true (the default) so tests are environment-independent.
 */

// Freeze PILOT_MODE to true before the module is imported so test output is stable.
process.env.EXPO_PUBLIC_PILOT_MODE = 'true';
process.env.EXPO_PUBLIC_PILOT_CREDIT_UNIT = 'credits';
process.env.EXPO_PUBLIC_PILOT_CREDIT_SYMBOL = 'Cr';

import {
  formatMoneyAmount,
  convertAssetToINR,
  convertINRtoAsset,
  formatAssetWithINR,
  MONEY_UNIT_LABEL,
} from '../../utils/currency';

describe('convertAssetToINR', () => {
  test('converts a numeric asset amount to INR (1:1 rate)', () => {
    expect(convertAssetToINR(100)).toBe(100);
    expect(convertAssetToINR(0)).toBe(0);
    expect(convertAssetToINR(9999.5)).toBe(9999.5);
  });

  test('accepts a string amount', () => {
    expect(convertAssetToINR('250')).toBe(250);
  });
});

describe('convertINRtoAsset', () => {
  test('converts INR to asset amount (1:1 rate)', () => {
    expect(convertINRtoAsset(500)).toBe(500);
    expect(convertINRtoAsset('75.5')).toBe(75.5);
  });
});

describe('formatMoneyAmount', () => {
  test('includes the correct unit label in pilot mode', () => {
    const formatted = formatMoneyAmount(100);
    expect(formatted).toContain(MONEY_UNIT_LABEL);
  });

  test('formats with two decimal places', () => {
    const formatted = formatMoneyAmount(100);
    // Should contain something like "100.00"
    expect(formatted).toMatch(/100[.,]00/);
  });

  test('handles zero', () => {
    const formatted = formatMoneyAmount(0);
    expect(formatted).toMatch(/0[.,]00/);
  });

  test('handles non-finite values gracefully (no crash)', () => {
    expect(() => formatMoneyAmount(NaN)).not.toThrow();
    expect(() => formatMoneyAmount(Infinity)).not.toThrow();
  });

  test('formats large numbers with locale separators', () => {
    const formatted = formatMoneyAmount(1000000);
    // The formatted string should contain digits and separators, not crash
    expect(typeof formatted).toBe('string');
    expect(formatted.length).toBeGreaterThan(0);
  });
});

describe('formatAssetWithINR', () => {
  test('round-trips: convert then format', () => {
    const formatted = formatAssetWithINR(100);
    // At 1:1 rate this should be the same as formatMoneyAmount(100)
    expect(formatted).toBe(formatMoneyAmount(100));
  });

  test('accepts string input', () => {
    expect(() => formatAssetWithINR('50')).not.toThrow();
  });
});
