/**
 * Unit tests for pilot utility functions.
 */

describe('isPilotAccessCodeValid', () => {
  afterEach(() => {
    jest.resetModules();
    delete process.env.EXPO_PUBLIC_PILOT_MODE;
    delete process.env.EXPO_PUBLIC_PILOT_ACCESS_CODE;
  });

  test('returns true when no access code is configured (open access)', () => {
    process.env.EXPO_PUBLIC_PILOT_MODE = 'true';
    process.env.EXPO_PUBLIC_PILOT_ACCESS_CODE = '';
    const { isPilotAccessCodeValid } = require('../../utils/pilot');
    expect(isPilotAccessCodeValid('')).toBe(true);
    expect(isPilotAccessCodeValid('anything')).toBe(true);
  });

  test('returns true for the correct access code (case-insensitive)', () => {
    process.env.EXPO_PUBLIC_PILOT_MODE = 'true';
    process.env.EXPO_PUBLIC_PILOT_ACCESS_CODE = 'BETA2026';
    const { isPilotAccessCodeValid } = require('../../utils/pilot');
    expect(isPilotAccessCodeValid('BETA2026')).toBe(true);
    expect(isPilotAccessCodeValid('beta2026')).toBe(true);
    expect(isPilotAccessCodeValid('  beta2026  ')).toBe(true);
  });

  test('returns false for an incorrect access code', () => {
    process.env.EXPO_PUBLIC_PILOT_MODE = 'true';
    process.env.EXPO_PUBLIC_PILOT_ACCESS_CODE = 'BETA2026';
    const { isPilotAccessCodeValid } = require('../../utils/pilot');
    expect(isPilotAccessCodeValid('wrong')).toBe(false);
    expect(isPilotAccessCodeValid('')).toBe(false);
  });

  test('PILOT_ACCESS_REQUIRED is true when a code is configured in pilot mode', () => {
    process.env.EXPO_PUBLIC_PILOT_MODE = 'true';
    process.env.EXPO_PUBLIC_PILOT_ACCESS_CODE = 'SECRET';
    const { PILOT_ACCESS_REQUIRED } = require('../../utils/pilot');
    expect(PILOT_ACCESS_REQUIRED).toBe(true);
  });

  test('PILOT_ACCESS_REQUIRED is false when no code is configured', () => {
    process.env.EXPO_PUBLIC_PILOT_MODE = 'true';
    process.env.EXPO_PUBLIC_PILOT_ACCESS_CODE = '';
    const { PILOT_ACCESS_REQUIRED } = require('../../utils/pilot');
    expect(PILOT_ACCESS_REQUIRED).toBe(false);
  });
});
