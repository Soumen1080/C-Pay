/**
 * Unit tests for date utility functions.
 * These are pure functions with no native dependencies.
 */

import {
  parseUTCDate,
  formatDateShort,
  formatDateLong,
  getRelativeTime,
} from '../../utils/date';

describe('parseUTCDate', () => {
  test('parses an ISO string with Z suffix as UTC', () => {
    const date = parseUTCDate('2026-01-10T12:00:00.000Z');
    expect(date.getTime()).toBe(new Date('2026-01-10T12:00:00.000Z').getTime());
  });

  test('parses a Supabase timestamp without timezone as UTC', () => {
    // Supabase sometimes omits the Z; the helper should append it
    const date = parseUTCDate('2026-01-10 12:00:00');
    expect(date.toISOString()).toBe('2026-01-10T12:00:00.000Z');
  });

  test('parses an ISO string without Z suffix as UTC', () => {
    const date = parseUTCDate('2026-01-10T12:00:00');
    expect(date.toISOString()).toBe('2026-01-10T12:00:00.000Z');
  });

  test('returns a valid Date for an empty string (fallback)', () => {
    // The function falls back to new Date() for empty input; just verify no throw
    expect(() => parseUTCDate('')).not.toThrow();
  });
});

describe('formatDateShort', () => {
  test('returns a non-empty string for a valid date', () => {
    const result = formatDateShort('2026-01-10T12:00:00.000Z');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  test('includes the year in the formatted output', () => {
    const result = formatDateShort('2026-01-10T12:00:00.000Z');
    expect(result).toContain('2026');
  });

  test('returns "N/A" for an empty string', () => {
    expect(formatDateShort('')).toBe('N/A');
  });
});

describe('formatDateLong', () => {
  test('returns a non-empty string for a valid date', () => {
    const result = formatDateLong('2026-01-10T12:00:00.000Z');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  test('returns "N/A" for an empty string', () => {
    expect(formatDateLong('')).toBe('N/A');
  });
});

describe('getRelativeTime', () => {
  test('returns "N/A" for empty input', () => {
    expect(getRelativeTime('')).toBe('N/A');
  });

  test('returns "Just now" for a timestamp within the last minute', () => {
    const nowIso = new Date(Date.now() - 10_000).toISOString(); // 10 s ago
    expect(getRelativeTime(nowIso)).toBe('Just now');
  });

  test('returns a "min ago" string for a timestamp 5 minutes ago', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const result = getRelativeTime(fiveMinAgo);
    expect(result).toContain('min');
  });

  test('returns an "hour ago" string for a timestamp 2 hours ago', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const result = getRelativeTime(twoHoursAgo);
    expect(result).toContain('hour');
  });

  test('returns a "day ago" string for a timestamp 3 days ago', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const result = getRelativeTime(threeDaysAgo);
    expect(result).toContain('day');
  });

  test('falls back to a formatted date for timestamps older than a week', () => {
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const result = getRelativeTime(twoWeeksAgo);
    // Should not be a relative-time string; should contain a year
    expect(result).not.toContain('ago');
    expect(result).not.toBe('Just now');
  });
});
